// The canonical pack id list. PackId derives from it, so the list and the
// union cannot drift apart; the registry's PACKS ids are pinned to this list
// by test/structure.test.ts, which keeps the installer's --packs validation
// honest against the registry truth.
// 'huaweicloud-cli' is a mixed knowledge+tools pack: the twenty service
// skills plus the seven KooCLI execution tools (the CLI face and its
// approval chain, sunk from core), while the meta tools that disclose packs
// (list_packs / pack_info / list_skills / retrieve_skill) stay in core so
// an enabled pack can always be discovered.
export const PACK_IDS = [
    'core',
    'huaweicloud-cli',
    'sandbox',
    'auth',
    'obs',
    'voucher',
    'update',
    'discovery',
    'huaweicloud-open-mcp',
    'secrets',
];
