import type { Abi, PublicClient } from "viem";

const MULTICALL_BATCH_SIZE = 50;
const DELAY_TIME_MS = 500;

/** Result type for multicall operations. */
export type MulticallResult = {
  /** Result data from the contract call */
  result?: unknown;
  /** Status of the call */
  status?: string;
  /** Error message if the call failed */
  error?: string;
};

/** Contract call configuration for multicall. */
export type MulticallContractCall = {
  /** Contract address */
  address: `0x${string}`;
  /** Contract ABI */
  abi: Abi;
  /** Function name to call */
  functionName: string;
  /** Optional function arguments */
  args?: readonly unknown[];
};

/**
 * Executes multiple contract calls in batches, with a delay between batches.
 * @param client - PublicClient instance for blockchain interaction
 * @param contracts - Array of contract calls to execute
 * @param batchSize - Number of calls per batch (default: 50)
 * @param delayMs - Delay in milliseconds between batches (default: 500)
 * @returns Array of results; entries are undefined for failed calls
 */
export async function batchedMulticall<MulticallResult>(
  client: PublicClient,
  contracts: MulticallContractCall[],
  batchSize = MULTICALL_BATCH_SIZE,
  delayMs = DELAY_TIME_MS
): Promise<(MulticallResult | undefined)[]> {
  function chunkArray<T>(
    arr: MulticallContractCall[],
    size: number
  ): MulticallContractCall[][] {
    const res: MulticallContractCall[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      res.push(arr.slice(i, i + size));
    }
    return res;
  }

  const callChunks = chunkArray(contracts, batchSize);
  let results: (MulticallResult | undefined)[] = [];
  for (const [index, chunk] of callChunks.entries()) {
    try {
      const chunkResults = await client.multicall({ contracts: chunk });
      results = results.concat(chunkResults as MulticallResult[]);
    } catch (e) {
      results = results.concat(Array(chunk.length).fill(undefined));
    }
    if (index < callChunks.length - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  return results;
}

/**
 * Creates a sequence for one quote-search operation, including its routes.
 * Await each run before starting the next. The next nonempty run pays the
 * previous run's final delay; the last result never waits on an idle timer.
 * Unrelated operations must use separate sequences, even on the same client.
 */
export function createBatchedMulticallSequence(
  client: PublicClient,
  batchSize = MULTICALL_BATCH_SIZE,
  delayMs = DELAY_TIME_MS
) {
  let hasCompletedRun = false;

  return async function run<Result>(
    contracts: MulticallContractCall[]
  ): Promise<(Result | undefined)[]> {
    if (contracts.length === 0) return [];
    if (hasCompletedRun) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      return await batchedMulticall<Result>(client, contracts, batchSize, delayMs);
    } finally {
      hasCompletedRun = true;
    }
  };
}
