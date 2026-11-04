# suis-20 snapshots

Produced by replaying `suis::inscription::InscriptionEvent` with rules `suis-20-v1`.

This directory is not the SuiMint Operation index (`../suirc20/`) and not the Movescriptions holder files (`../holders/`). Marketplace OrderDeal events and airdrops are not applied.

`ticks.json` is empty until a mainnet package id is set in `scripts/suis-package.json` and the indexer workflow runs. An empty file is a real snapshot: nothing has been deployed under this protocol on the scanned chain.

The tick string `suis` is not reserved.