# SUIRC20

Independent community frontend for SUIRC20 (Sui Movescriptions). Not affiliated with SuiMint or Movescriptions.

Live: https://suicommunityx.github.io/

Built with Vite + React + @mysten/dapp-kit (Slush wallet).

## suis

`#/ticks` is the suis-20 explorer (tick list, mint progress, holders, inscribe). `#/suis` opens the same list. Movescriptions stays on its own tab; its tick list is `#/moves`. `#/suimint` is unchanged.

Balances on the suis pages come only from `public/suis/ticks.json`, which is a replay of `InscriptionEvent`. They are not Operation balances and not OrderDeal fills. The tick string `suis` is not pinned.

Set `scripts/suis-package.json` `packageId` after the Move package is published, then run the "Refresh suis index" workflow. Until then the snapshot is empty on purpose.
