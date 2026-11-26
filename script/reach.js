#!/usr/bin/env node
/**
 * Punto de entrada de `npm run tdd:db:reach` (Script A).
 *
 * Dry-run por defecto: sin `--apply` NO escribe nada. Toda la lógica vive en
 * `script/lib/reachCli.js`; este archivo solo ejecuta la CLI y cierra el pool.
 */
import { main } from "./lib/reachCli.js";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`TDDLab reach: ${error.message ?? String(error)}`);
    process.exitCode = 2;
  });
