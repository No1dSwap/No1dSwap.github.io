/**
 * Verified No1d Swap protocol constants and clearly-marked Sepolia-only
 * demonstration bulletin board listings.
 *
 * Security rule: this static file intentionally holds ZERO mainnet invitation
 * codes. Every sample listing is Sepolia-only (`demo: true`) so it can be
 * inspected safely without risking accidental mainnet use.
 */

import {
  CHECKSUM_BYTES,
  CODE_PREFIX,
  KEYS,
  KIND,
  MAX_BYTES,
  MAX_CODE_CHARS,
  NETWORK_SPECS,
  URI_PREFIX,
  URI_SCHEME,
  encodeBech32m,
  encodeInvite,
  toChecksumAddress,
} from "./invite-codec.js";

const RELEASE_PUBKEY_B64 = "Thg9nhwwvqoKG4yOqiZM/PBeqT5LcrFFa7cKAHuqYxk=";
const VERSION = "0.2.0";
const REPO = "00Para/noid-swap";

export const PROTOCOL_CONSTANTS = Object.freeze({
  productName: "No1d Swap",
  version: VERSION,
  releaseStatus: "unreleased",
  releaseNote:
    "Version 0.2.0 is upcoming — check exact installer filenames, SHA-256 digests, and verification commands against the published signed release.json once released.",
  repo: REPO,
  releaseKey: Object.freeze({
    algorithm: "Ed25519",
    publicKeyB64: RELEASE_PUBKEY_B64,
    sourceFile: "desktop/lib/releasekey.js",
  }),
  installers: Object.freeze({
    windows: `No1d-Swap-${VERSION}-win-x64.exe`,
    macosArm64: `No1d-Swap-${VERSION}-mac-arm64.dmg`,
  }),
  verifyCommands: Object.freeze({
    notice: `node desktop/scripts/release-key.js verify --pub ${RELEASE_PUBKEY_B64} --in release.json --sig release.json.sig`,
    macSha256: `shasum -a 256 No1d-Swap-${VERSION}-mac-arm64.dmg`,
    winSha256: `Get-FileHash No1d-Swap-${VERSION}-win-x64.exe`,
    linuxSha256: `sha256sum No1d-Swap-${VERSION}-linux-x64.AppImage`,
    attestation: `gh attestation verify <installer-file> --repo ${REPO}`,
  }),
  mainnet: Object.freeze({
    network: "mainnet",
    profile: "production",
    label: "Ethereum Mainnet",
    chainId: 1,
    contract: NETWORK_SPECS.mainnet.pinnedContract,
    codeHash: "0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3",
    contractFile: "eth/contracts/HTLCPoseidonV2.sol",
    deployedDateUtc: "2026-11-20",
    deployedBlock: 26459748,
    contractVersion: 1,
    maxNoid: NETWORK_SPECS.mainnet.maxNoid,
    maxNoidMicro: NETWORK_SPECS.mainnet.maxNoidMicro.toString(),
    maxEth: NETWORK_SPECS.mainnet.maxEth,
    maxEthWei: NETWORK_SPECS.mainnet.maxEthWei.toString(),
    defaultFeeCapGwei: "1",
    defaultTipGwei: "0.05",
  }),
  sepolia: Object.freeze({
    network: "sepolia",
    profile: "sepolia",
    label: "Sepolia Testnet",
    chainId: 11155111,
    contract: NETWORK_SPECS.sepolia.pinnedContract,
    allowedContractVersions: NETWORK_SPECS.sepolia.allowedContractVersions,
    maxNoid: NETWORK_SPECS.sepolia.maxNoid,
    maxNoidMicro: NETWORK_SPECS.sepolia.maxNoidMicro.toString(),
    maxEth: NETWORK_SPECS.sepolia.maxEth,
    maxEthWei: NETWORK_SPECS.sepolia.maxEthWei.toString(),
    note: "Parano1d has no testnet; NOID locked in Sepolia swaps is real mainnet NOID.",
  }),
  parano1d: Object.freeze({
    contractFile: "parano1d/contracts/htlc.pruv",
    contractName: "HashTimeLock",
    instructions: 1,
    maxInstructions: 16,
    fundingFeeMicro: "9000",
    closeFeeMicro: "5800",
    sweepFeeMicro: "5800",
    blockNomSeconds: 30,
    blockFastSeconds: 20,
    // 18 blocks for finality (B_final = 19 includes the inclusion block).
    finalityBlocks: 18,
  }),
  timings: Object.freeze({
    usualMinutes: 50,
    ethFinalityMinutes: 19,
    mainnet: Object.freeze({
      aliceRefundBack: "about 6 h 45 min",
      bobRefundBack: "about 2 h 20 min",
      bobClaimWindowMinutes: 75,
    }),
    sepolia: Object.freeze({
      aliceRefundBack: "about 3 h 5 min",
      bobRefundBack: "about 1 h 30 min",
      bobClaimWindowMinutes: 5,
    }),
  }),
  minerConcentration: Object.freeze({
    recentProducerPct: "about 75%",
    recentProducerDateUtc: "2026-11-23",
    observedRangePct: "45% to 63%",
    lastDayPct: "52.7%",
    measuredDateUtc: "2026-11-08",
    toolRefusalPct: 35,
    bobApprovalCeilingPct: 65,
    boardWarning:
      "A listing is not a check. The program checks the terms; the miner limit still applies to the ETH side.",
  }),
  trackRecord: Object.freeze({
    version: VERSION,
    asOf: "2026-11-24",
    mainnetSettled: 1,
    mainnetRefunded: 0,
    note: "both sides run by the developer, with the terminal tools, before this program",
  }),
  inviteFormat: Object.freeze({
    kind: KIND,
    prefix: CODE_PREFIX,
    uriScheme: URI_SCHEME,
    uriPrefix: URI_PREFIX,
    uriBehaviorNote:
      "Pre-fill only — identical to pasting the code. Never approves, deposits, starts a step, or skips the check-line match. The OS handler lives in the desktop program.",
    desktopInternalOrigin: "no1d://app",
    version: 1,
    checksumBytes: CHECKSUM_BYTES,
    maxBytes: MAX_BYTES,
    maxCodeChars: MAX_CODE_CHARS,
    keys: KEYS,
  }),
});

// Deterministic synthetic demo addresses (valid Bech32m & EIP-55, Sepolia samples only).
function demoNoidAddress(tag) {
  const bytes = new Uint8Array(32);
  bytes[0] = 0xde;
  bytes[1] = 0x00;
  for (let i = 2; i < 31; i++) bytes[i] = (tag * 37 + i * 13) & 0xff;
  bytes[31] = tag & 0xff;
  return encodeBech32m(bytes, "o");
}

function demoEthAddress(tag) {
  const hexTag = tag.toString(16).padStart(4, "0");
  return toChecksumAddress(`0xde0000000000000000000000000000000000${hexTag}`);
}

// Sepolia-only sample listings — zero mainnet codes in sample data.
const DEMO_SPECS = [
  {
    id: "sample-sep-01",
    tag: 0x0201,
    network: "sepolia",
    noidAmount: "5",
    ethAmount: "0.001",
    note: "Sample Sepolia listing — inspection preview only (remember: NOID is real even on Sepolia).",
    postedAtUtc: "2026-11-25T15:20:00Z",
  },
  {
    id: "sample-sep-02",
    tag: 0x0202,
    network: "sepolia",
    noidAmount: "10",
    ethAmount: "0.002",
    note: "Sample Sepolia listing — mid-range test size for inspecting invite fields.",
    postedAtUtc: "2026-11-25T15:45:00Z",
  },
  {
    id: "sample-sep-03",
    tag: 0x0203,
    network: "sepolia",
    noidAmount: "20",
    ethAmount: "0.004",
    note: "Sample Sepolia listing — at the 20 NOID Sepolia per-swap cap.",
    postedAtUtc: "2026-11-25T16:05:00Z",
  },
];

function buildDemoOffer(spec) {
  if (spec.network !== "sepolia") {
    throw new Error(`Sample offers must be Sepolia-only (${spec.id})`);
  }
  const bobNoid = demoNoidAddress(spec.tag);
  const bobEth = demoEthAddress(spec.tag);
  const encoded = encodeInvite({
    network: "sepolia",
    noidAmount: spec.noidAmount,
    ethAmount: spec.ethAmount,
    bobNoid,
    bobEth,
  });
  if (!encoded.ok) {
    throw new Error(`Invalid sample offer ${spec.id}: ${encoded.error}`);
  }
  return Object.freeze({
    id: spec.id,
    demo: true,
    label: "Sample Listing (Sepolia)",
    note: spec.note,
    postedAtUtc: spec.postedAtUtc,
    code: encoded.canonicalCode,
  });
}

export const DEMO_OFFERS = Object.freeze(DEMO_SPECS.map(buildDemoOffer));
