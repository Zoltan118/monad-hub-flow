// scripts/update-flows.ts
//
// What this does:
// - Reads scripts/protocols.json (list of protocol contracts)
// - Uses Blockvision Monad RPC to fetch MON token Transfer logs
// - Aggregates flows: Wallets -> Protocol and Protocol -> Wallets
// - Writes:
//     client/src/data/mon_flows_24h.json
//     client/src/data/mon_flows_7d.json
//
// Requirements:
// - env BLOCKVISION_RPC_URL = your full RPC URL, e.g.
//     https://monad-mainnet.blockvision.org/v1/36ZJUzc1b0PQTSvx5IHzzevvh5g
// - env MON_TOKEN_ADDRESS   = MON ERC-20 token address on Monad
//   (18 decimals assumed – adjust if needed)

import fs from "fs";
import path from "path";

// ------------ Config via env ------------

const RPC_URL = process.env.BLOCKVISION_RPC_URL;
const MON_TOKEN_ADDRESS = (process.env.MON_TOKEN_ADDRESS || "").toLowerCase();

if (!RPC_URL) {
  console.error("BLOCKVISION_RPC_URL is not set.");
  process.exit(1);
}
if (!MON_TOKEN_ADDRESS) {
  console.error("MON_TOKEN_ADDRESS is not set.");
  process.exit(1);
}

// Transfer(address,address,uint256)
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Monad ~1s block time → rough approximations
const BLOCKS_24H = 24 * 60 * 60; // 86,400
const BLOCKS_7D = 7 * BLOCKS_24H;

// ------------ Types ------------

interface ProtocolConfig {
  contracts: string[];
  category?: string;
}

type ProtocolsFile = Record<string, ProtocolConfig>;

interface RpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: any[];
}

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface Log {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

interface FlowEntry {
  source: string;
  target: string;
  volume: number;
}

interface FlowFile {
  period: string;
  lastUpdated: string;
  totalVolume: number;
  flows: FlowEntry[];
}

// ------------ Helpers ------------

// Simple JSON-RPC POST to Blockvision
async function rpcCall<T>(method: string, params: any[] = []): Promise<T> {
  const body: RpcRequest = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  };

  const res = await fetch(RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as RpcResponse<T>;

  if (json.error) {
    throw new Error(
      `RPC error ${json.error.code}: ${json.error.message}`
    );
  }

  if (json.result === undefined) {
    throw new Error(`No result for method ${method}`);
  }

  return json.result;
}

function hexToBigInt(hex: string): bigint {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

function weiToMon(value: bigint, decimals = 18): number {
  if (value === 0n) return 0;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  return (
    Number(whole) + Number(fraction) / Number(base)
  );
}

// last N blocks approximated by blockNumber - N
function blockOffset(latestBlock: bigint, offset: number): string {
  const off = BigInt(offset);
  const from = latestBlock > off ? latestBlock - off : 0n;
  return "0x" + from.toString(16);
}

// ------------ Load protocols ------------

function loadProtocols(): ProtocolsFile {
  const p = path.join(__dirname, "protocols.json");
  if (!fs.existsSync(p)) {
    console.warn("protocols.json not found, using empty config");
    return {};
  }
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as ProtocolsFile;
}

// ------------ Fetch logs for period ------------

async function fetchMonTransferLogsForPeriod(
  blocksBack: number
): Promise<Log[]> {
  const latestHex = await rpcCall<string>("eth_blockNumber");
  const latest = hexToBigInt(latestHex);

  const fromBlock = blockOffset(latest, blocksBack);
  const toBlock = latestHex;

  console.log(
    `Fetching logs for MON from block ${fromBlock} to ${toBlock}`
  );

  const filter = {
    address: MON_TOKEN_ADDRESS,
    fromBlock,
    toBlock,
    topics: [TRANSFER_TOPIC],
  };

  const logs = await rpcCall<Log[]>("eth_getLogs", [filter]);
  console.log(`Got ${logs.length} logs for period ~${blocksBack} blocks.`);
  return logs;
}

// ------------ Build flows ------------

async function buildFlowsForPeriod(
  protocols: ProtocolsFile,
  blocksBack: number
): Promise<FlowFile> {
  const logs = await fetchMonTransferLogsForPeriod(blocksBack);

  // Normalize protocol contracts → protocol name
  const contractToProtocol = new Map<string, string>();
  for (const [name, cfg] of Object.entries(protocols)) {
    for (const addr of cfg.contracts || []) {
      contractToProtocol.set(addr.toLowerCase(), name);
    }
  }

  const volumeMap = new Map<string, number>();

  const addFlow = (source: string, target: string, vol: number) => {
    if (vol <= 0) return;
    const key = `${source}|||${target}`;
    const prev = volumeMap.get(key) || 0;
    volumeMap.set(key, prev + vol);
  };

  for (const log of logs) {
    const [topic0, topicFrom, topicTo] = log.topics;

    if (topic0.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!topicFrom || !topicTo) continue;

    // topics[1] and [2] are indexed addresses (32-byte)
    const from =
      "0x" + topicFrom.slice(26).toLowerCase(); // last 40 hex chars
    const to =
      "0x" + topicTo.slice(26).toLowerCase();

    const valueBig = hexToBigInt(log.data);
    const valueMon = weiToMon(valueBig);

    const fromProt = contractToProtocol.get(from);
    const toProt = contractToProtocol.get(to);

    // Cases:
    // Wallet -> Protocol (deposit, swap into protocol)
    if (!fromProt && toProt) {
      addFlow("Wallets", toProt, valueMon);
    }

    // Protocol -> Wallet (withdraw, swap out)
    if (fromProt && !toProt) {
      addFlow(fromProt, "Wallets", valueMon);
    }

    // Protocol A -> Protocol B (rare but possible)
    if (fromProt && toProt && fromProt !== toProt) {
      addFlow(fromProt, toProt, valueMon);
    }
  }

  const flows: FlowEntry[] = Array.from(volumeMap.entries()).map(
    ([key, volume]) => {
      const [source, target] = key.split("|||");
      return { source, target, volume };
    }
  );

  const totalVolume = flows.reduce(
    (sum, f) => sum + f.volume,
    0
  );

  return {
    period: "raw", // will be overwritten by caller
    lastUpdated: new Date().toISOString(),
    totalVolume,
    flows,
  };
}

// ------------ Main ------------

async function main() {
  const protocols = loadProtocols();
  console.log("Loaded protocols:", Object.keys(protocols));

  const dataDir = path.join(process.cwd(), "client/src/data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const [flows24, flows7d] = await Promise.all([
    buildFlowsForPeriod(protocols, BLOCKS_24H),
    buildFlowsForPeriod(protocols, BLOCKS_7D),
  ]);

  const file24: FlowFile = {
    ...flows24,
    period: "24h",
  };

  const file7d: FlowFile = {
    ...flows7d,
    period: "7d",
  };

  const out24 = path.join(dataDir, "mon_flows_24h.json");
  const out7d = path.join(dataDir, "mon_flows_7d.json");

  fs.writeFileSync(out24, JSON.stringify(file24, null, 2));
  fs.writeFileSync(out7d, JSON.stringify(file7d, null, 2));

  console.log("Wrote:", out24);
  console.log("Wrote:", out7d);
}

main().catch((err) => {
  console.error("Fatal error in update-flows:", err);
  process.exit(1);
});
