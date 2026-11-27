// Conexión a DB-B (Neon) para los scripts tdd:db:reach y tdd:db:cycles.
//
// La URL NUNCA se versiona: se resuelve en este orden de precedencia:
//   1. Variables de entorno reales, en este orden:
//        TDDLAB_DATABASE_URL
//        BRANCH_SUPPORT_DATABASE_URL
//        DATABASE_URL
//   2. El archivo `.env` de la raíz del proyecto (con las mismas tres claves)
//   3. Si nada aplica, los scripts fallan con un mensaje claro (exit 1)
//      y no tocan nada.
//
// El `.env` está excluido de git (.gitignore) y sus valores jamás se imprimen.
// No se usa `dotenv`: el parser es propio, mínimo y sin dependencias.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

export const ENV_VARS = [
  "TDDLAB_DATABASE_URL",
  "BRANCH_SUPPORT_DATABASE_URL",
  "DATABASE_URL",
];

// ---------------------------------------------------------------------------
// Lectura del .env
// ---------------------------------------------------------------------------

/**
 * Parsea el contenido de un archivo .env a un objeto.
 * Soporta: comentarios (`#`), líneas vacías, `export CLAVE=valor`, valores
 * entrecomillados (con escape de \n \r \t \" \\ en comillas dobles) y CRLF.
 * Ignora líneas sin `=` o con clave inválida. NO extrae comentarios en línea
 * (una URL puede contener `#`).
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
  const out = {};
  if (typeof text !== "string" || !text) return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    let value = match[2].trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        const inner = value.slice(1, -1);
        value =
          first === '"'
            ? inner
                .replace(/\\n/g, "\n")
                .replace(/\\r/g, "\r")
                .replace(/\\t/g, "\t")
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, "\\")
            : inner;
      }
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Busca un `.env` subiendo desde `startDir` hasta la raíz del proyecto
 * (el directorio que contiene `.git` o `package.json`). No sale nunca de
 * ahí, para no leer archivos de otros proyectos.
 *
 * @returns {string|null} ruta absoluta o null
 */
export function findDotEnvFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir || ".");
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;

    const isProjectRoot =
      fs.existsSync(path.join(dir, ".git")) ||
      fs.existsSync(path.join(dir, "package.json"));
    const parent = path.dirname(dir);
    if (isProjectRoot || parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Lee y parsea el `.env` del proyecto. Si no existe (o no se puede leer)
 * devuelve `{}`. Nunca lanza y nunca imprime valores.
 *
 * @param {string} [startDir]
 * @returns {Record<string, string>}
 */
export function readDotEnv(startDir = process.cwd()) {
  const file = findDotEnvFile(startDir);
  if (!file) return {};
  try {
    return parseDotEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Resolución de la URL
// ---------------------------------------------------------------------------

/**
 * Resuelve la URL de DB-B con la precedencia:
 * variable de entorno real > `.env` > null.
 *
 * Función pura: el `.env` se pasa como parámetro para poder testearla sin
 * tocar el disco. Usa `getPool()` / `resolveConnectionString()` tal cual para
 * que lea el `.env` automáticamente.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, string>} [dotEnv]
 * @returns {string|null}
 */
export function resolveConnectionString(env = process.env, dotEnv = {}) {
  for (const name of ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const name of ENV_VARS) {
    const value = dotEnv[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function missingConfigMessage() {
  return (
    "Falta la URL de la base de datos DB-B. Define una de estas variables de entorno: " +
    `${ENV_VARS.join(", ")} (o agrégualas a un archivo .env en la raíz del proyecto, ` +
    "que también se lee). Ejemplo (PowerShell): " +
    '$env:TDDLAB_DATABASE_URL="postgresql://..."'
  );
}

let pool = null;

/**
 * Pool único (lazy). Lanza un error explícito si falta la configuración.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, string>} [dotEnv] inyectable para tests; por defecto
 *   se lee el `.env` real del proyecto.
 */
export function getPool(env = process.env, dotEnv) {
  const dot = dotEnv === undefined ? readDotEnv() : dotEnv;
  const connectionString = resolveConnectionString(env, dot);
  if (!connectionString) {
    throw new Error(missingConfigMessage());
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      // Los scripts son de corta vida: no mantener conexiones abiertas.
      max: 2,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

/** Consulta sobre el pool compartido. Los scripts solo emiten SELECT. */
export async function query(sql, params) {
  return getPool().query(sql, params);
}

// ---------------------------------------------------------------------------
// Preflight del esquema de DB-B (solo lectura)
// ---------------------------------------------------------------------------

/**
 * Tablas que forman el esquema de topología de ramas (DB-B).
 *
 * Este es el único esquema que entienden `reach`, `cycles` y los hooks.
 * La otra base Neon de la aplicación (`commitstable`, `jobstable`,
 * `commit_timeline`, `submissions`, …) NO contiene ramas, aristas de
 * parentesco ni ejecuciones por rama: no es intercambiable.
 */
export const REQUIRED_TABLES = Object.freeze([
  "project",
  "branch",
  "git_commit",
  "branch_commit",
  "commit_parent",
  "test_execution",
  "test_result",
]);

/** Mensaje claro para el caso de apuntar a la base equivocada. */
export function wrongSchemaMessage(missing) {
  const list = Array.isArray(missing) ? missing : [missing];
  return (
    `La URL configurada no apunta a DB-B: faltan las tablas ${list.join(", ")}. ` +
    "DB-B es la base con project/branch/git_commit/branch_commit/commit_parent/" +
    "test_execution/test_result. La base de la aplicación (commitstable, " +
    "jobstable, commit_timeline, submissions, …) no sirve para reach/cycles: " +
    "define TDDLAB_DATABASE_URL o BRANCH_SUPPORT_DATABASE_URL con la URL de DB-B."
  );
}

/**
 * Devuelve las tablas requeridas que faltan en `public`. No crea nada.
 *
 * @param {(sql: string, params: any[]) => Promise<{rows: any[]}>} [queryFn]
 * @returns {Promise<string[]>} tablas ausentes (vacío = esquema OK)
 */
export async function checkBranchSupportSchema(queryFn = query) {
  const { rows } = await queryFn(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [REQUIRED_TABLES]
  );
  const present = new Set(rows.map((row) => row.table_name));
  return REQUIRED_TABLES.filter((name) => !present.has(name));
}

/**
 * Lanza un error con `code = "WRONG_DATABASE_SCHEMA"` si la URL apunta a otra
 * base. Solo SELECT: no altera datos ni esquema.
 *
 * @param {(sql: string, params: any[]) => Promise<{rows: any[]}>} [queryFn]
 */
export async function assertBranchSupportSchema(queryFn = query) {
  const missing = await checkBranchSupportSchema(queryFn);
  if (missing.length === 0) return;
  const error = new Error(wrongSchemaMessage(missing));
  error.code = "WRONG_DATABASE_SCHEMA";
  error.missing_tables = missing;
  throw error;
}

/** Cierra el pool (para tests y para salir limpio). */
export async function closePool() {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}
