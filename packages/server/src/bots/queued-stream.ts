// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BotResponseStream } from '@medplum/core';
import type { Job } from 'bullmq';
import bytes from 'bytes';
import { Writable } from 'node:stream';
import { getConfig } from '../config/loader';

export interface QueuedStreamProgress {
  readonly kind: 'bot-stream';
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly chunks: string[];
}

/** Accumulates a bounded stream in job progress; each snapshot supersedes the previous one. */
export class QueuedBotStream extends Writable implements BotResponseStream {
  private status?: number;
  private headers: Record<string, string> = {};
  private readonly chunks: string[] = [];
  private size = 0;
  private timer?: NodeJS.Timeout;
  private pending: Promise<void> = Promise.resolve();
  private failure?: Error;

  private readonly job: Job;

  constructor(job: Job) {
    super();
    this.job = job;
    // Stream errors are propagated by flushProgress, never emitted as unhandled errors.
    this.on('error', (error: Error) => {
      this.failure = error;
    });
  }

  startStreaming(status: number, headers: Record<string, string>): void {
    if (this.status !== undefined || !Number.isInteger(status) || status < 200 || status > 599) {
      throw new Error('Invalid streaming response');
    }
    const size = Buffer.byteLength(JSON.stringify(headers));
    const limit = bytes(getConfig().maxJsonSize);
    if (limit === null || size > limit) {
      throw new Error('Streaming response exceeds the configured JSON size limit');
    }
    this.status = status;
    this.headers = headers;
    this.size = size;
    this.schedule();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const limit = bytes(getConfig().maxJsonSize);
    const encoded = chunk.toString('base64');
    this.size += Buffer.byteLength(encoded) + 4;
    if (this.status === undefined || limit === null || this.size > limit) {
      const error = new Error('Invalid or oversized streaming response');
      this.failure = error;
      callback(error);
      return;
    }
    this.chunks.push(encoded);
    this.schedule();
    callback();
  }

  private schedule(): void {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.publish();
      }, 200);
      this.timer.unref();
    }
  }

  private publish(): void {
    if (this.status === undefined) {
      return;
    }
    const progress: QueuedStreamProgress = {
      kind: 'bot-stream',
      status: this.status,
      headers: this.headers,
      chunks: [...this.chunks],
    };
    this.pending = this.pending
      .then(() => this.job.updateProgress(progress))
      .catch(() => {
        this.failure = new Error('Could not publish streaming response');
      });
  }

  async flushProgress(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;
    this.publish();
    await this.pending;
    if (this.failure) {
      throw this.failure;
    }
  }
}
