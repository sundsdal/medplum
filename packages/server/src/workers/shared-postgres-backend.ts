// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { PostgresConnectionOptions, QueueBaseOptions } from 'bullmq';
import { PostgresConnection, PostgresQueueBackend } from 'bullmq';

/** Serialize the public LISTEN client queries shared by queue backends. */
export class SharedPostgresConnection extends PostgresConnection {
  private readonly clients = new WeakMap<object, Awaited<ReturnType<PostgresConnection['getListenClient']>>>();

  override async getListenClient(): ReturnType<PostgresConnection['getListenClient']> {
    const client = await super.getListenClient();
    const existing = this.clients.get(client);
    if (existing) {
      return existing;
    }
    let pending: Promise<unknown> = Promise.resolve();
    const wrapped = new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'query') {
          return (...args: unknown[]) => {
            const result = pending.then(() => Reflect.apply(value, target, args));
            pending = result.then(
              () => undefined,
              () => undefined
            );
            return result;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    this.clients.set(client, wrapped);
    return wrapped;
  }
}

/** A queue backend that borrows the process-wide listener and never closes it. */
export class SharedPostgresBackend extends PostgresQueueBackend {
  private readonly onError = (error: Error): void => {
    this.emit('error', error);
  };
  private readonly onReady = (): void => {
    this.emit('ready');
  };
  private readonly onClose = (): void => {
    this.emit('close');
  };
  private closed = false;
  private readonly onInvalidated = (): void => {
    // Unblock the old wait, then make the next worker wait subscribe again.
    this.disconnectBlocking()
      .then(() => {
        if (!this.closed) {
          return this.reconnectBlocking();
        }
        return undefined;
      })
      .catch(this.onError);
  };

  private readonly shared: PostgresConnection;

  constructor(shared: PostgresConnection, name: string, opts: QueueBaseOptions<PostgresConnectionOptions>) {
    super(shared, name, opts, false);
    this.shared = shared;
    shared.on('error', this.onError);
    shared.on('ready', this.onReady);
    shared.on('close', this.onClose);
    shared.on('listenerinvalidated', this.onInvalidated);
  }

  override async close(): Promise<void> {
    this.closed = true;
    await this.disconnectBlocking();
    await super.disconnect();
    this.shared.off('error', this.onError);
    this.shared.off('ready', this.onReady);
    this.shared.off('close', this.onClose);
    this.shared.off('listenerinvalidated', this.onInvalidated);
  }

  override async disconnect(): Promise<void> {
    await this.close();
  }
}
