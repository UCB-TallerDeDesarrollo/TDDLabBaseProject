#### Proyeto base para proyectos tddlab:

#### Creado a partir de proyecto usado en IngSoftware: parcel-jest-base

https://github.com/israelantezana/parcel-jest-base

#### Comandos creados en package json:

#### Para instalar las dependencias:

npm install

#### Comandos de uso:

Ejecutar web-sever local parcel:
npm start

Ejecutar pruebas de unidad de forma continua --watch:
npm test

Ejecutar pruebas de unidad solo una vez:
npm run test-once

---

## Scripts de diagnóstico sobre DB-B

Dos scripts manuales (`tdd:db:cycles`, `tdd:db:reach`), ambos de **solo lectura
sobre la base de datos** salvo `--apply` explícito en `tdd:db:reach`. No
reemplazan el flujo existente (`tdd_log.json` / `commit-history.json`).
Además, `reach` se ejecuta **automáticamente desde los hooks de Git** (F4),
siempre con `--apply` y solo cuando hay configuración válida de Neon.
`cycles` sigue siendo **exclusivamente manual**.

### Configuración (variables de entorno)

La URL de la base **nunca se versiona**: se resuelve con esta precedencia.

1. Variables de entorno reales, en este orden:
   1. `TDDLAB_DATABASE_URL`
   2. `BRANCH_SUPPORT_DATABASE_URL`
   3. `DATABASE_URL`
2. **Archivo `.env` en la raíz del proyecto** (con las mismas tres claves).
   Los scripts lo leen automáticamente, sin necesidad de exportar nada:
   basta con tener el `.env` y correr el comando.
3. Si nada aplica, salen con código `1` y un mensaje explícito **sin tocar nada**.

```powershell
# Opción A: archivo .env en la raíz del proyecto (recomendada)
#   TDDLAB_DATABASE_URL=postgresql://...
#   (o BRANCH_SUPPORT_DATABASE_URL=... / DATABASE_URL=...)
npm run tdd:db:cycles -- --audit
```

```powershell
# Opción B: variable de entorno en la sesión actual (gana sobre el .env)
$env:TDDLAB_DATABASE_URL = "postgresql://usuario:clave@host/db?sslmode=require"
npm run tdd:db:cycles -- --audit
```

```bash
# Opción B en bash / zsh
export TDDLAB_DATABASE_URL="postgresql://usuario:clave@host/db?sslmode=require"
```

Notas de seguridad:

- `.env` y `.env.*` están en `.gitignore` (`.env.example` sí se puede versionar).
  Verificado con `git check-ignore`.
- Los scripts **no imprimen nunca** el valor de la URL ni de `PGPASSWORD`.
- La búsqueda del `.env` sube desde el directorio de trabajo hasta la raíz
  del proyecto (donde haya `.git` o `package.json`) y **no sale de ahí**, para
  no leer archivos de otros proyectos.
- No se usa `dotenv`: el parser es propio, mínimo y sin dependencias.

### `npm run tdd:db:cycles` — clasificación de ciclos TDD (Script B)

Solo SELECT: sin INSERT/UPDATE/DELETE, sin migraciones, sin locks.

```
npm run tdd:db:cycles -- --audit                        # todas las ramas vivas
npm run tdd:db:cycles -- --audit --project owner/repo --branch main
npm run tdd:db:cycles -- --audit --json                 # salida por máquina
npm run tdd:db:cycles -- --orphans                      # registros que el grafo no ve
npm run tdd:db:cycles -- --help
```

`--audit` compara la clasificación que hoy calcula DB-B (`getTDDCyclesGraph`)
con la propuesta (el clasificador puro `script/lib/tddCycleClassifier.js`) e
informa el motivo de cada divergencia:

| Motivo | Significado |
| --- | --- |
| `sin-ejecucion-marcado-rojo` | El grafo pinta rojo un commit sin ejecuciones locales |
| `secuencia-colapsada` | Un commit con rojo→ verde se ve solo como rojo |
| `fuga-entre-ramas` | Sin ejecuciones locales pero con heredadas de otra rama |
| `merge-mal-etiquetado` | El merge tiene fase distinta de `unknown` |
| `refactor-por-diff` | El grafo afirma refactor sin evidencia verificable |
| `color-distinto` | El color del grafo y el propuesto no coinciden |

### `npm run tdd:db:reach` — alcanzabilidad de commits (Script A)

Garantiza que `branch_commit` contenga **todos** los commits alcanzables desde
el HEAD de la rama, corrige `branch.head_commit_sha` desfasado y completa
`commit_parent` en merges.

```
npm run tdd:db:reach                      # dry-run: NO escribe nada (por defecto)
npm run tdd:db:reach -- --apply           # escribe en DB-B
npm run tdd:db:reach -- --json
npm run tdd:db:reach -- --project owner/repo [--branch nombre] [--max-commits 1000]
npm run tdd:db:reach -- --help
```

Reglas:

- **Dry-run por defecto**: sin `--apply` no hay ninguna escritura.
- **Idempotente**: re-ejecutar con `--apply` no duplica nada
  (`ON CONFLICT DO NOTHING`); si ya está reconciliado responde `noop`.
- **Nunca borra**: los commits que dejan de ser alcanzables se reportan como
  `stale`, jamás se eliminan.
- **Orden por FK**: `git_commit` → `commit_parent` → `branch` → `branch_commit`
  → `branch.head_commit_sha`, todo dentro de una transacción con `ROLLBACK`
  ante cualquier error.
- El proyecto/rama se **crean** si faltan (find-or-create); si la rama está
  marcada como borrada en DB-B, el script se niega a trabajar sobre ella.
- `branch_commit` significa "alcanzable desde", no "creado en": un commit
  creado en otra rama aparece tras el merge (eso es correcto).

### Integración automática con hooks de Git (F4)

`reach --apply` se dispara solo desde estos cuatro hooks, para mantener
`branch_commit` / `commit_parent` / `branch.head_commit_sha` alineados con el
historial real sin intervención manual:

| Hook | Cuándo |
| --- | --- |
| `post-commit` | Después de cada commit (**después del `git commit --amend` del proyecto**, para registrar el SHA final) |
| `post-merge` | Después de un merge (o fast-forward) |
| `post-checkout` | Después de `git checkout` / `git switch` (la rama destino pasa a ser HEAD) |
| `post-rewrite` | Después de `git commit --amend` / `git rebase` (cambian los SHAs) |

```
commit / merge / checkout / rebase
        └─> .husky/<hook>
                └─> node script/hookSync.js <hook>
                        └─> si hay config de Neon → node script/lib/reachCli.js --apply
                        └─> si no config / error → skip, exit 0
```

Seguridad y garantías:

- **No bloquea Git nunca.** `hookSync.js` siempre devuelve código `0`. Los
  hooks además usan `|| true` y terminan en `exit 0`. Si Neon no responde,
  falla la DNS o el puerto está cerrado, la operación de Git continúa igual.
- **Config mínima:** si no hay variable de entorno ni `.env`, el hook hace
  `skip (no-config)` sin intentar conectar (no hay falsos errores).
- **Watchdog:** `TDDLAB_HOOK_TIMEOUT_MS` (por defecto `30000` ms) evita que un
  `checkout` se quede colgado. Al dispararse se cierra la conexión y Postgres
  hace `ROLLBACK` de la transacción abierta: no queda estado parcial.
- **Anti-recursión:** el `post-commit` original ya exporta `HUSKY=0` antes del
  `git commit --amend`; F4 conserva eso y añade `TDDLAB_INTERNAL=1` durante el
  amend (doble guarda: ni los hooks ni `hookSync` se re-ejecutan). Ambos se
  limpian antes de sincronizar. `TDDLAB_INTERNAL=1` también funciona como
  **kill-switch manual** de la auto-sincronización:
  ```powershell
  $env:TDDLAB_INTERNAL = "1"   # desactiva reach automático mientras dure la sesión
  ```
- **Idempotente y aditivo:** `reach` usa `ON CONFLICT DO NOTHING`, no borra
  registros (los commits inalcanzables se reportan como `stale`, nunca se
  eliminan) y no modifica el historial de Git.
- **`cycles` NUNCA corre desde hooks.** Sigue siendo manual (`npm run tdd:db:cycles ...`).
- **Salida mínima:** una sola línea `tdd-sync: ...` sin URL, usuario ni clave.
- **Historial intacto:** el `post-commit` conserva el orden original
  (`HUSKY_SKIP_TRACK` → `commitScript.js` → `commit-tracker.js` → `git add` →
  `git commit --amend --no-edit` → `unset HUSKY`) y solo añade la sincronización
  al final. Los scripts originales de registro de pruebas no se tocaron.

Los tests de integración (`script/hookSync.test.js`) validan las 4 hooks, la
anti-recursión, la ausencia de `.env`, Neon caído, que un fallo no bloquea Git
y que el `post-commit` original se conserva (45 pruebas nuevas; `pg`, `git` y
los archivos `.husky/` se leen/ mockean, sin conexiones reales).

### Tests

```
npx jest
```

Cubren el clasificador, la paridad de color, la auditoría, la capa de conexión,
ambos CLIs y la integración con los hooks (`pg` y `git` mockeados: no abren
conexiones reales ni ejecutan git).

