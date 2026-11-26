#!/usr/bin/env node
/**
 * Punto de entrada de `npm run tdd:db:cycles` (Script B, solo lectura).
 *
 * Toda la lógica vive en `script/lib/cyclesCli.js`; este archivo solo
 * ejecuta la CLI y cierra el pool al salir. Ver `--help`.
 */
import { main } from "./lib/cyclesCli.js";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (error) => {
    console.error(`Error: ${error.message ?? String(error)}`);
    process.exitCode = 1;
  });
