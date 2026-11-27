#!/usr/bin/env node
/**
 * Punto de entrada de los hooks de Git (F4).
 *
 * Uso (lo llaman los hooks, no hace falta invocarlo a mano):
 *   node script/hookSync.js post-commit
 *   node script/hookSync.js post-merge
 *   node script/hookSync.js post-checkout
 *   node script/hookSync.js post-rewrite
 *
 * SIEMPRE sale con código 0: un fallo de sincronización nunca puede impedir
 * que Git complete un commit, merge, checkout o rebase.
 */
import { main } from "./lib/hookSync.js";

main(process.argv.slice(2))
  .then((code) => {
    // Defensa extra: process.exitCode solo acepta números.
    process.exitCode = typeof code === "number" ? code : 0;
  })
  .catch((error) => {
    // Última red de seguridad: jamás propagamos un error hacia Git.
    console.error(`tdd-sync: ${error?.message ?? String(error)}`);
    process.exitCode = 0;
  });
