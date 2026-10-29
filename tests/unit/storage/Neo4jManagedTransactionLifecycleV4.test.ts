import { Neo4jError, internal, type TransactionPromise } from 'neo4j-driver-core';

const { TransactionExecutor } = internal.transactionExecutor;

type SyntheticTransaction = {
  isOpen(): boolean;
  run(query: string): Promise<{ query: string }>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

type TransactionCreator = () => TransactionPromise;

function retriableDriverError(message: string): Neo4jError {
  return new Neo4jError(message, 'ServiceUnavailable', 'N/A', 'N/A');
}

function transactionPromise(transaction: SyntheticTransaction): TransactionPromise {
  return Promise.resolve(transaction) as unknown as TransactionPromise;
}

function createExecutor(): InstanceType<typeof TransactionExecutor> {
  return new TransactionExecutor(2_000, 0, 1, 0);
}

describe('installed Neo4j managed TransactionExecutor lifecycle', () => {
  it('re-enters after a retriable commit acknowledgement error and stops at the returned callback sentinel', async () => {
    const events: string[] = [];
    const originalResource = { mutations: 0 };
    const callbackReturnedError = new Error('managed callback already returned');
    const commitAcknowledgementError = retriableDriverError('commit acknowledgement lost');
    let callbackReturned = false;
    let retryResource: typeof originalResource | undefined;
    let transactionCount = 0;
    let runCount = 0;
    let commitCount = 0;
    let rollbackCount = 0;
    let workMutationCount = 0;

    const transactionCreator: TransactionCreator = () => {
      const attempt = ++transactionCount;
      events.push(`transaction:${attempt}`);
      let open = true;
      return transactionPromise({
        isOpen: () => open,
        run: async (query) => {
          runCount += 1;
          events.push(`run:${attempt}`);
          return { query };
        },
        commit: async () => {
          commitCount += 1;
          events.push(`commit:${attempt}`);
          // A commit acknowledgement can be lost after submission. The first
          // tx is therefore closed even though the executor receives an error.
          open = false;
          if (attempt === 1) throw commitAcknowledgementError;
        },
        rollback: async () => {
          rollbackCount += 1;
          events.push(`rollback:${attempt}`);
          open = false;
        },
      });
    };

    const executor = createExecutor();
    try {
      await expect(
        executor.execute<string, SyntheticTransaction>(transactionCreator, async (tx) => {
          // This is deliberately the first callback instruction. A re-entry
          // after success must not issue tx.run or mutate captured work data.
          if (callbackReturned) {
            retryResource = originalResource;
            events.push('returned-callback-sentinel');
            throw callbackReturnedError;
          }

          events.push('work:start');
          await tx.run('RETURN 1');
          originalResource.mutations += 1;
          workMutationCount += 1;
          events.push('work:returning');
          callbackReturned = true;
          return 'prepared';
        }),
      ).rejects.toBe(callbackReturnedError);
    } finally {
      executor.close();
    }

    expect(Neo4jError.isRetriable(commitAcknowledgementError)).toBe(true);
    expect(Neo4jError.isRetriable(callbackReturnedError)).toBe(false);
    expect(callbackReturned).toBe(true);
    expect(retryResource).toBe(originalResource);
    expect(originalResource.mutations).toBe(1);
    expect(workMutationCount).toBe(1);
    expect(transactionCount).toBe(2);
    expect(runCount).toBe(1);
    expect(commitCount).toBe(1);
    expect(rollbackCount).toBe(1);
    expect(events.indexOf('work:returning')).toBeLessThan(events.indexOf('commit:1'));
    expect(events.indexOf('commit:1')).toBeLessThan(events.indexOf('returned-callback-sentinel'));
    expect(events.indexOf('returned-callback-sentinel')).toBeLessThan(events.indexOf('rollback:2'));
  });

  it.each([
    {
      label: 'ordinary callback error',
      createError: () => new Error('ordinary callback failure'),
      expectedAttempts: 1,
      shouldResolve: false,
    },
    {
      label: 'actual retriable Neo4j callback error',
      createError: () => retriableDriverError('known-uncommitted transient failure'),
      expectedAttempts: 2,
      shouldResolve: true,
    },
  ])(
    'rolls back a failed callback before retrying only an actual retriable Neo4j error: $label',
    async ({ createError, expectedAttempts, shouldResolve }) => {
      const events: string[] = [];
      const injectedError = createError();
      let callbackReturned = false;
      let transactionCount = 0;
      let workBodyCount = 0;
      let runCount = 0;
      let commitCount = 0;
      let rollbackCount = 0;

      const transactionCreator: TransactionCreator = () => {
        const attempt = ++transactionCount;
        events.push(`transaction:${attempt}`);
        let open = true;
        return transactionPromise({
          isOpen: () => open,
          run: async (query) => {
            runCount += 1;
            events.push(`run:${attempt}`);
            return { query };
          },
          commit: async () => {
            commitCount += 1;
            events.push(`commit:${attempt}`);
            open = false;
          },
          rollback: async () => {
            rollbackCount += 1;
            events.push(`rollback:${attempt}`);
            open = false;
          },
        });
      };

      const executor = createExecutor();
      try {
        const execution = executor.execute<string, SyntheticTransaction>(
          transactionCreator,
          async (tx) => {
            if (callbackReturned)
              throw new Error('successful callback was unexpectedly re-entered');
            workBodyCount += 1;
            events.push(`work:${workBodyCount}`);
            await tx.run('RETURN 1');
            if (workBodyCount === 1) throw injectedError;
            events.push('work:returning');
            callbackReturned = true;
            return 'prepared';
          },
        );

        if (shouldResolve) {
          await expect(execution).resolves.toBe('prepared');
        } else {
          await expect(execution).rejects.toBe(injectedError);
        }
      } finally {
        executor.close();
      }

      expect(Neo4jError.isRetriable(injectedError)).toBe(shouldResolve);
      expect(transactionCount).toBe(expectedAttempts);
      expect(workBodyCount).toBe(expectedAttempts);
      expect(runCount).toBe(expectedAttempts);
      expect(rollbackCount).toBe(1);
      expect(commitCount).toBe(shouldResolve ? 1 : 0);
      if (shouldResolve) {
        expect(injectedError).toBeInstanceOf(Neo4jError);
        expect(callbackReturned).toBe(true);
        expect(events.indexOf('rollback:1')).toBeLessThan(events.indexOf('transaction:2'));
        expect(events.indexOf('transaction:2')).toBeLessThan(events.indexOf('work:2'));
        expect(events.indexOf('work:returning')).toBeLessThan(events.indexOf('commit:2'));
      } else {
        expect(callbackReturned).toBe(false);
        expect(events).not.toContain('transaction:2');
      }
    },
  );
});
