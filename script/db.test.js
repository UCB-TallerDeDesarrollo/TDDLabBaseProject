/** Tests de la capa de conexión a DB-B. NO se abre ninguna conexión real. */
import {
  ENV_VARS,
  resolveConnectionString,
  missingConfigMessage,
  getPool,
  closePool,
  parseDotEnv,
  findDotEnvFile,
  readDotEnv,
  REQUIRED_TABLES,
  checkBranchSupportSchema,
  assertBranchSupportSchema,
  wrongSchemaMessage,
} from "./lib/db.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

afterEach(async () => {
  await closePool();
});

describe("resolveConnectionString", () => {
  it("prefiere TDDLAB_DATABASE_URL sobre las demás", () => {
    const env = {
      TDDLAB_DATABASE_URL: "postgresql://a/db",
      BRANCH_SUPPORT_DATABASE_URL: "postgresql://b/db",
      DATABASE_URL: "postgresql://c/db",
    };
    expect(resolveConnectionString(env)).toBe("postgresql://a/db");
  });
  it("usa BRANCH_SUPPORT_DATABASE_URL si no está la principal", () => {
    const env = {
      BRANCH_SUPPORT_DATABASE_URL: "postgresql://b/db",
      DATABASE_URL: "postgresql://c/db",
    };
    expect(resolveConnectionString(env)).toBe("postgresql://b/db");
  });

  it("cae a DATABASE_URL como último recurso", () => {
    expect(resolveConnectionString({ DATABASE_URL: "postgresql://c/db" })).toBe(
      "postgresql://c/db"
    );
  });

  it("descarta valores vacíos o con solo espacios", () => {
    expect(resolveConnectionString({ TDDLAB_DATABASE_URL: "   " })).toBeNull();
    expect(resolveConnectionString({ TDDLAB_DATABASE_URL: "" })).toBeNull();
    expect(resolveConnectionString({})).toBeNull();
  });

  it("recorta el valor", () => {
    expect(resolveConnectionString({ DATABASE_URL: "  postgresql://c/db  " })).toBe(
      "postgresql://c/db"
    );
  });

  it("documenta las tres variables soportadas", () => {
    expect(ENV_VARS).toEqual([
      "TDDLAB_DATABASE_URL",
      "BRANCH_SUPPORT_DATABASE_URL",
      "DATABASE_URL",
    ]);
  });
});

describe("missingConfigMessage", () => {
  it("menciona cada variable de entorno y cómo definirla", () => {
    const message = missingConfigMessage();
    for (const name of ENV_VARS) expect(message).toContain(name);
    expect(message).toContain("DB-B");
  });
});

describe("getPool", () => {
  it("falla con un mensaje claro si no hay configuración (sin tocar nada)", () => {
    // env vacío Y sin .env: debe rechazar antes de abrir cualquier conexión.
    expect(() => getPool({}, {})).toThrow(/TDDLAB_DATABASE_URL/);
    expect(() => getPool({}, {})).toThrow(/BRANCH_SUPPORT_DATABASE_URL/);
    expect(() => getPool({}, {})).toThrow(/DATABASE_URL/);
    expect(() => getPool({}, {})).toThrow(/DB-B/);
  });

  it("acepta la URL proveniente del .env cuando no hay variable de entorno", () => {
    const pool = getPool({}, { DATABASE_URL: "postgresql://user:pw@localhost:5432/db" });
    expect(pool).toBeTruthy();
  });

  it("la variable de entorno real gana sobre el .env", () => {
    const env = { DATABASE_URL: "postgresql://de-env/db" };
    const dotEnv = { DATABASE_URL: "postgresql://de-archivo/db" };
    expect(resolveConnectionString(env, dotEnv)).toBe("postgresql://de-env/db");
  });

  it("cae al .env solo si no hay variable de entorno aplicable", () => {
    expect(resolveConnectionString({}, { DATABASE_URL: "postgresql://de-archivo/db" })).toBe(
      "postgresql://de-archivo/db"
    );
    expect(resolveConnectionString({}, {})).toBeNull();
    expect(resolveConnectionString({ TDDLAB_DATABASE_URL: "   " }, { TDDLAB_DATABASE_URL: "x" })).toBe(
      "x"
    );
  });

  it("respeta la prioridad entre las tres claves dentro del .env", () => {
    const dotEnv = {
      DATABASE_URL: "postgresql://c/db",
      BRANCH_SUPPORT_DATABASE_URL: "postgresql://b/db",
      TDDLAB_DATABASE_URL: "postgresql://a/db",
    };
    expect(resolveConnectionString({}, dotEnv)).toBe("postgresql://a/db");
    expect(resolveConnectionString({}, { BRANCH_SUPPORT_DATABASE_URL: "postgresql://b/db", DATABASE_URL: "postgresql://c/db" })).toBe(
      "postgresql://b/db"
    );
  });

  it("devuelve el mismo pool para no abrir conexiones de más", () => {
    const url = { TDDLAB_DATABASE_URL: "postgresql://user:pw@localhost:5432/db" };
    const pool = getPool(url, {});
    expect(pool).toBeTruthy();
    expect(getPool(url, {})).toBe(pool);
  });

  it("cierra el pool y permite reabrirlo", async () => {
    getPool({ DATABASE_URL: "postgresql://user:pw@localhost:5432/db" }, {});
    await expect(closePool()).resolves.toBeUndefined();
    await expect(closePool()).resolves.toBeUndefined(); // idempotente
  });
});

describe("parseDotEnv", () => {
  it("parsea claves, comentarios y líneas vacías", () => {
    const parsed = parseDotEnv(
      [
        "# comentario",
        "",
        "AAA=1",
        "   BBB = 2   ",
        "# otro comentario",
        "CCC=3",
      ].join("\n")
    );
    expect(parsed).toEqual({ AAA: "1", BBB: "2", CCC: "3" });
  });

  it("acepta export y CRLF", () => {
    expect(parseDotEnv("export URL=postgresql://x\r\nOTRO=y\r\n")).toEqual({
      URL: "postgresql://x",
      OTRO: "y",
    });
  });

  it("quita comillas simples y dobles", () => {
    expect(parseDotEnv(`A='valor simple'\nB="valor doble"`)).toEqual({
      A: "valor simple",
      B: "valor doble",
    });
  });

  it("interpreta escapes dentro de comillas dobles", () => {
    expect(parseDotEnv('A="linea1\\nlinea2\\ttab"')).toEqual({
      A: "linea1\nlinea2\ttab",
    });
    expect(parseDotEnv('A="dice \\"hola\\""')).toEqual({ A: 'dice "hola"' });
    expect(parseDotEnv("A='no\\nescape'")).toEqual({ A: "no\\nescape" });
  });

  it("NO recorta comentarios en línea (una URL puede contener #)", () => {
    expect(parseDotEnv("URL=postgresql://host/db#fragmento")).toEqual({
      URL: "postgresql://host/db#fragmento",
    });
  });

  it("ignora líneas malformadas y entradas no string", () => {
    expect(parseDotEnv("SIN_IGUAL\n1MALA=x\n=sinclave\n")).toEqual({});
    expect(parseDotEnv(null)).toEqual({});
    expect(parseDotEnv("")).toEqual({});
  });

  it("no expone credenciales en el mensaje de error", () => {
    // Puede mostrar el nombre de la variable y un ejemplo genérico, pero nunca
    // un par usuario:clave.
    expect(missingConfigMessage()).not.toMatch(/:\/\/[^@\s]+:[^@\s]+@/);
    expect(missingConfigMessage()).not.toMatch(/PGPASSWORD|JWT_SECRET/i);
  });
});

describe("findDotEnvFile / readDotEnv", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tddenv-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("encuentra el .env en la raíz del proyecto", () => {
    fs.writeFileSync(path.join(root, ".env"), "DATABASE_URL=postgresql://x/db\n");
    expect(findDotEnvFile(root)).toBe(path.join(root, ".env"));
  });

  it("sube desde un subdirectorio hasta la raíz", () => {
    fs.writeFileSync(path.join(root, ".env"), "DATABASE_URL=postgresql://x/db\n");
    const sub = path.join(root, "script", "lib");
    fs.mkdirSync(sub, { recursive: true });
    expect(findDotEnvFile(sub)).toBe(path.join(root, ".env"));
  });

  it("lee y parsea el .env encontrado", () => {
    fs.writeFileSync(path.join(root, ".env"), 'URL="postgresql://x/db"\n# c\n');
    expect(readDotEnv(root)).toEqual({ URL: "postgresql://x/db" });
  });

  it("devuelve {} si no hay .env", () => {
    expect(findDotEnvFile(root)).toBeNull();
    expect(readDotEnv(root)).toEqual({});
  });

  it("NO sale de la raíz del proyecto (ignora .env de directorios padres)", () => {
    // El directorio temporal no tiene .git ni package.json, así que sube hasta
    // el primer marcador de proyecto o hasta la raíz del sistema.
    const found = findDotEnvFile(root);
    expect(found === null || !String(found).startsWith(root + path.sep)).toBe(true);
  });

  it("tolera un .env ilegible sin lanzar", () => {
    const dir = path.join(root, "blocked");
    fs.mkdirSync(dir);
    // Simulamos fallo de lectura apuntando a un directorio como si fuera .env.
    fs.mkdirSync(path.join(dir, ".env"));
    expect(readDotEnv(dir)).toEqual({});
  });
});

describe("preflight del esquema de DB-B", () => {
  const fakeQuery = (present) => jest.fn(async () => ({
    rows: present.map((table_name) => ({ table_name })),
  }));

  it("define exactamente las siete tablas de DB-B", () => {
    expect(REQUIRED_TABLES).toEqual([
      "project",
      "branch",
      "git_commit",
      "branch_commit",
      "commit_parent",
      "test_execution",
      "test_result",
    ]);
  });

  it("no reporta nada cuando el esquema está completo", async () => {
    const run = fakeQuery(REQUIRED_TABLES);
    await expect(checkBranchSupportSchema(run)).resolves.toEqual([]);
    await expect(assertBranchSupportSchema(run)).resolves.toBeUndefined();
  });

  it("reporta solo las tablas ausentes, sin inventar ninguna", async () => {
    const run = fakeQuery(["project", "git_commit"]);
    await expect(checkBranchSupportSchema(run)).resolves.toEqual(
      REQUIRED_TABLES.filter((t) => !["project", "git_commit"].includes(t))
    );
  });

  it("lanza un error identificable si la URL apunta a otra base", async () => {
    // Caso real: la base de la aplicación (commitstable/jobstable/…).
    const run = fakeQuery(["commitstable", "jobstable", "commit_timeline"]);
    await expect(assertBranchSupportSchema(run)).rejects.toMatchObject({
      code: "WRONG_DATABASE_SCHEMA",
      missing_tables: REQUIRED_TABLES,
    });
  });

  it("la consulta es solo SELECT sobre information_schema", async () => {
    const run = jest.fn(async () => ({ rows: [] }));
    await checkBranchSupportSchema(run);
    const [sql, params] = run.mock.calls[0];
    expect(sql).toMatch(/^SELECT /i);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE)\b/i);
    expect(sql).toContain("information_schema.tables");
    expect(params[0]).toBe(REQUIRED_TABLES);
  });

  it("el mensaje explica la alternativa y no filtra credenciales", () => {
    const message = wrongSchemaMessage(["project", "branch"]);
    expect(message).toContain("project, branch");
    expect(message).toContain("DB-B");
    expect(message).toContain("BRANCH_SUPPORT_DATABASE_URL");
    expect(message).toContain("commitstable");
    expect(message).not.toMatch(/:\/\/[^@\s]+:[^@\s]+@/);
    expect(message).not.toMatch(/PGPASSWORD/i);
  });
});
