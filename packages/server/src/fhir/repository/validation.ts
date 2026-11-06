// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { TypedValueWithPath, ValidatorOptions } from '@medplum/core';
import {
  badRequest,
  getReferenceString,
  isResource,
  isUUID,
  OperationOutcomeError,
  Operator,
  validateResource,
} from '@medplum/core';
import type {
  CodeableConcept,
  Coding,
  Communication,
  Cron,
  OperationOutcomeIssue,
  Reference,
  Resource,
  StructureDefinition,
  ValueSet,
} from '@medplum/fhirtypes';
import { isValidCron } from 'cron-validator';
import { getConfig } from '../../config/loader';
import { getLogger } from '../../logger';
import { recordHistogramValue } from '../../otel/otel';
import { validateResourceWithJsonSchema } from '../jsonschema';
import { findTerminologyResource } from '../operations/utils/terminology';
import { validateCodingInValueSet } from '../operations/valuesetvalidatecode';
import type { Repository } from '../repo';

/**
 * Validates a resource against the current project configuration.
 * If strict mode is enabled (default), validates against base StructureDefinition and all profiles.
 * If strict mode is disabled, validates against the legacy JSONSchema validator.
 * Throws on validation errors.
 * Returns silently on success.
 * @param repo - The repository to use for validation.
 * @param resource - The candidate resource to validate.
 */
export async function validateRepositoryResource(repo: Repository, resource: Resource): Promise<void> {
  if (resource.resourceType === 'Cron') {
    validateCronString(resource);
    await validateCronReferences(repo, resource);
  }
  if (resource.resourceType === 'Communication' && getConfig().spacesOwnedConversationsEnabled) {
    await validateSpacesConversation(repo, resource);
  }

  if (repo.getConfig().strictMode) {
    await validateRepositoryResourceStrictly(repo, resource);
  } else {
    // Perform loose validation first to detect any severe issues
    validateResourceWithJsonSchema(resource);

    // Attempt strict validation and log warnings on failure
    try {
      await validateRepositoryResourceStrictly(repo, resource);
    } catch (err: any) {
      getLogger().warn('Strict validation would fail', {
        resource: getReferenceString(resource),
        err,
      });
    }
  }
}

const spacesIdentifierSystem = 'http://medplum.com/ai-message';

function hasSpacesIdentifier(resource: Communication, value: string): boolean {
  return (
    resource.identifier?.some(
      (identifier) => identifier.system === spacesIdentifierSystem && identifier.value === value
    ) ?? false
  );
}

/**
 * Check the literal parent before conditional references are rewritten.
 * @param resource - The proposed resource.
 */
export function validateSpacesParentSyntax(resource: Resource): void {
  if (
    !getConfig().spacesOwnedConversationsEnabled ||
    resource.resourceType !== 'Communication' ||
    !hasSpacesIdentifier(resource, 'ai-message')
  ) {
    return;
  }
  const parts = resource.partOf?.[0]?.reference?.split('/');
  if (resource.partOf?.length !== 1 || parts?.length !== 2 || parts[0] !== 'Communication' || !isUUID(parts[1])) {
    throw new OperationOutcomeError(
      badRequest('Spaces message requires one local Communication topic', 'Communication.partOf')
    );
  }
}

/**
 * Validate the relationship separately from the access policy, which controls who may write.
 * @param repo - The author's repository with its existing access policy.
 * @param resource - The proposed Spaces Communication.
 */
async function validateSpacesConversation(repo: Repository, resource: Communication): Promise<void> {
  const topic = hasSpacesIdentifier(resource, 'ai-message-topic');
  const message = hasSpacesIdentifier(resource, 'ai-message');
  if (!topic && !message) {
    return;
  }
  const sender = resource.sender?.reference;
  const senderParts = sender?.split('/');
  if (
    senderParts?.length !== 2 ||
    !['Patient', 'Practitioner', 'RelatedPerson'].includes(senderParts[0]) ||
    !isUUID(senderParts[1])
  ) {
    throw new OperationOutcomeError(
      badRequest('Spaces conversation requires a local sender reference', 'Communication.sender')
    );
  }
  if (topic) {
    if (message || resource.partOf?.length) {
      throw new OperationOutcomeError(
        badRequest('Spaces topic cannot have a parent or message identifier', 'Communication.partOf')
      );
    }
    return;
  }
  const parent = resource.partOf?.[0];
  validateSpacesParentSyntax(resource);
  // Keep server metadata for the project check without changing the caller's access policy.
  const [resolved] = await repo.withOverrideConfig({ extendedMode: true }).readReferences([parent as Reference]);
  if (
    !isResource(resolved) ||
    resolved.resourceType !== 'Communication' ||
    !hasSpacesIdentifier(resolved, 'ai-message-topic') ||
    hasSpacesIdentifier(resolved, 'ai-message') ||
    resolved.partOf?.length ||
    resolved.sender?.reference !== sender ||
    !resource.meta?.project ||
    resolved.meta?.project !== resource.meta.project
  ) {
    throw new OperationOutcomeError(
      badRequest('Cannot resolve an owned Spaces topic in this project', 'Communication.partOf')
    );
  }
}

/**
 * Rejects a `Cron` whose schedule cannot be parsed.
 *
 * A cron expression resists being stated as a FHIRPath constraint -- an inverted range such as
 * `10-2` is well formed but invalid -- and constraints only warn outside strict mode. Checking here
 * means a schedule the worker cannot use fails the write instead of silently never firing.
 * @param cron - The Cron resource being written.
 */
function validateCronString(cron: Cron): void {
  if (cron.cronString && !isValidCron(cron.cronString)) {
    throw new OperationOutcomeError(badRequest(`Invalid cron expression: '${cron.cronString}'`, 'Cron.cronString'));
  }
}

/**
 * Rejects a `Cron` whose target or identity the author cannot read.
 *
 * Resolving each reference through the author's own repository is the whole check, which is why no
 * project comparison appears here: `Bot` may come from a linked project that exports it, while
 * `ProjectMembership` is a project admin type and so never crosses a link -- keeping the access
 * policy a run assumes inside the Cron's own project. Rejecting on write means a job that could
 * only ever fail never reaches the scheduler.
 * @param repo - The repository writing the Cron, carrying the author's access.
 * @param cron - The Cron resource being written.
 */
async function validateCronReferences(repo: Repository, cron: Cron): Promise<void> {
  // Cardinality and the cron-1/cron-2 constraints already cover a missing or logical reference.
  const checks: { reference: Reference; path: string }[] = [
    { reference: cron.targetReference, path: 'Cron.targetReference' },
    { reference: cron.onBehalfOf, path: 'Cron.onBehalfOf' },
  ].filter((check) => check.reference?.reference);

  // readReferences resolves both in one pass, and reports only a reference the author cannot reach
  // as an Error: any other read failure propagates, rather than being blamed on the Cron.
  const results = await repo.readReferences(checks.map((check) => check.reference));
  for (let i = 0; i < results.length; i++) {
    if (!isResource(results[i])) {
      const { reference, path } = checks[i];
      throw new OperationOutcomeError(badRequest(`Cannot resolve '${reference.reference}'`, path));
    }
  }
}

export async function validateRepositoryResourceStrictly(repo: Repository, resource: Resource): Promise<void> {
  const logger = getLogger();
  const start = process.hrtime.bigint();
  const context = repo.getConfig();

  // Prepare validator options
  let options: ValidatorOptions | undefined;
  if (context.validateTerminology) {
    const tokens = Object.create(null);
    options = { ...options, collect: { tokens } };
  }

  // Validate resource against base FHIR spec
  const issues = validateResource(resource, { ...options, base64BinaryMaxBytes: getConfig().base64BinaryMaxBytes });

  for (const issue of issues) {
    logger.warn(`Validator warning: ${issue.details?.text}`, { project: context.projects?.[0]?.id, issue });
  }

  // Validate profiles after verifying compliance with base spec
  const profileUrls = resource.meta?.profile;
  if (profileUrls) {
    await validateProfiles(repo, resource, profileUrls, options);
  }

  // (Optionally) check any required terminology bindings found
  if (context.validateTerminology && options?.collect?.tokens) {
    await validateTerminology(repo, options.collect.tokens, issues);
    if (issues.some((iss) => iss.severity === 'error')) {
      throw new OperationOutcomeError({ resourceType: 'OperationOutcome', issue: issues });
    }
  }

  // Track latency for successful validation
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6; // Convert nanoseconds to milliseconds
  recordHistogramValue('medplum.server.validationDurationMs', durationMs, { options: { unit: 'ms' } });
  if (durationMs > 10) {
    logger.debug('High validator latency', {
      resourceType: resource.resourceType,
      id: resource.id,
      durationMs,
    });
  }
}

async function validateProfiles(
  repo: Repository,
  resource: Resource,
  profileUrls: string[],
  options?: ValidatorOptions
): Promise<void> {
  const logger = getLogger();
  for (const url of profileUrls) {
    const loadStart = process.hrtime.bigint();
    const profile = await loadProfile(repo, url);
    const loadTime = Number(process.hrtime.bigint() - loadStart);
    if (!profile) {
      logger.warn('Unknown profile referenced', {
        resource: `${resource.resourceType}/${resource.id}`,
        url,
      });
      continue;
    }

    const validateStart = process.hrtime.bigint();
    validateResource(resource, { ...options, profile });
    const validateTime = Number(process.hrtime.bigint() - validateStart);
    logger.debug('Profile loaded', {
      url,
      loadTime,
      validateTime,
    });
  }
}

async function validateTerminology(
  repo: Repository,
  tokens: Record<string, TypedValueWithPath[]>,
  issues: OperationOutcomeIssue[]
): Promise<void> {
  for (const [url, values] of Object.entries(tokens)) {
    const valueSet = await findTerminologyResource<ValueSet>(repo, 'ValueSet', url);

    const resultCache: Record<string, boolean | undefined> = Object.create(null);
    for (const value of values) {
      let codings: Coding[] | undefined;
      switch (value.type) {
        case 'CodeableConcept':
          codings = (value.value as CodeableConcept).coding;
          break;
        case 'Coding':
          codings = [value.value as Coding];
          break;
        default: {
          const cachedResult = resultCache[`${value.type}|${value.value}`];
          if (cachedResult === false) {
            issues.push({
              severity: 'error',
              code: 'value',
              details: { text: `Value ${JSON.stringify(value.value)} did not satisfy terminology binding ${url}` },
              expression: [value.path],
            });
          }
          if (cachedResult !== undefined) {
            continue;
          }
          codings = [{ code: value.value as string }];
          break;
        }
      }
      if (!codings?.length) {
        continue;
      }

      const matchedCoding = await validateCodingInValueSet(repo, valueSet, codings);
      resultCache[`${value.type}|${value.value}`] = Boolean(matchedCoding);
      if (!matchedCoding) {
        issues.push({
          severity: 'error',
          code: 'value',
          details: { text: `Value ${JSON.stringify(value.value)} did not satisfy terminology binding ${url}` },
          expression: [value.path],
        });
      }
    }
  }
}

async function loadProfile(repo: Repository, url: string): Promise<StructureDefinition | undefined> {
  // Descending version sort approximates version resolution for some cases
  return repo.searchOne<StructureDefinition>({
    resourceType: 'StructureDefinition',
    filters: [
      {
        code: 'url',
        operator: Operator.EQUALS,
        value: url,
      },
    ],
    sortRules: [
      {
        code: 'version',
        descending: true,
      },
      {
        code: 'date',
        descending: true,
      },
    ],
  });
}
