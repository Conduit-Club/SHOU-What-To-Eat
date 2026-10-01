import {rm} from 'node:fs/promises';
// Build output only: production catalog routes are always served by the Worker.
// Do not leave a stale static alternative reachable through asset URL aliases.
for(const file of ['catalog-index.json','catalog-snapshot.json'])await rm(new URL('../dist/'+file,import.meta.url),{force:true});
