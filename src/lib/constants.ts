/** On-chain constants for Movescriptions + market (mainnet). */
export const NETWORK = 'mainnet' as const;

/** JSON-RPC hosts that still serve legacy methods (Foundation fullnode deprecated). */
export const RPC_URL = 'https://mainnet.suiet.app';
export const RPC_FALLBACKS: string[] = [
  'https://mainnet.suiet.app',
];

export const TYPE_PACKAGE =
  '0x830fe26674dc638af7c3d84030e2575f44a2bdc1baa1f4757cfe010a4b106b6a';
/** Latest Movescriptions package for moveCall targets (v16). */
export const CALL_PACKAGE =
  '0x88a632719f065fae7509d335584e8ef9ea3cb528c77bb8d325835303d36c382e';

export const MOVESCRIPTION_TYPE = `${TYPE_PACKAGE}::movescription::Movescription`;
export const TICK_RECORD_V2_TYPE = `${TYPE_PACKAGE}::movescription::TickRecordV2`;
export const TICK_RECORD_TYPE = `${TYPE_PACKAGE}::movescription::TickRecord`;

export const DEPLOY_RECORD =
  '0x8fb949a8ae112ee025401cdb6dcdcfe04a8817bc2912a778a875e6b3697715da';
export const DEPLOY_TABLE =
  '0xbf93cd99f4f8e2663afdb8d9cdcb642ce3e171add2d88aa3f02c47294b052eeb';

/** Market type package (original) + latest call package (v18). */
export const MARKET_TYPE_PACKAGE =
  '0xb88f9149c55d6314b7ae436a730cfbf3a5d53522f37e2d56288531bb8adc7071';
export const MARKET_CALL_PACKAGE =
  '0x6db09c0709c91d743502e27f06a2352f62c1459c3c1ca9d1b3ee4a110e3f8ea0';
export const MARKETPLACE_HOUSE =
  '0x4a207448a10234ab1929779f3712b3d89adb17fbea6948bb176b36a2b2171eb6';

export const CLOCK = '0x6';

/** Known tick → Marketplace shared object (seeded so market works without house crawl). */
export const KNOWN_MARKETS: Record<string, string> = {
  CREATOR: '0x71480b38034d352bb63bf4623c1d44ae45332c346d8bb07e55469c63bc28f345',
  GAME: '0x3ab6b81708f107230469ac70e08b06aef70f094a5a97dcd74a28aa69dbbf92ac',
  IKUN: '0x9d860c6c19e6a23c9bb82783bd7a608e03e431ced3f040da5f468841ae981c1e',
  KRISWU: '0x1b62a73465dd23ac1eed46344cfbc02c0b9b964733de23adbb84853bfb3bf41d',
  LORDS: '0x2a4d417bf3e20695fdfc851ef79b0c98ecb2672476b77e65f4703011456399db',
  MOVE: '0x27e6805a007b8c18276693feaf089c2f2b613c166e728bc5b47749bab4291103',
  MOVEER: '0x4c15496b2f7211413153b2b01b99090691e7c210be8507e30d13a76868f2c29b',
  MRC20: '0x0142102f4020f7f768153e350863c8ae929a0bd0f032e0db336c9c70bbac344e',
  MYWORLD: '0x89ef561f2642cd6d4800a784874ed5a4e82d291acf6301ed7875652fb26228ee',
  OTTER: '0xcef73af3b096b5d49f06291d360cb842250b31bdfff975cefb3b36f99d2299be',
  PLATON: '0x48eaeecbc1f1ae846b3ee5066331ebe251d3cd4cdc5701ef9c6acedeec1d6457',
  SUIS: '0x20aac987cf2e33b56d4f883724e19c0b986f6b56c07ee9588c8f3cebaecc6c9b',
  SUIZ: '0x43e31eb68fd130f673773b68407ad16ca5251d5e20dec4f354b70d33e66e716e',
};

export const SITE_NAME = 'Sui Inscription';

/** sessionStorage TTL for RPC responses (ms). */
export const CACHE_TTL_MS = 60_000;
