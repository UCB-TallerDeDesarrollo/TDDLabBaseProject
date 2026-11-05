#### Proyeto base para proyectos tddlab:

#### Creado a partir de proyecto usado en IngSoftware: parcel-jest-base

https://github.com/israelantezana/parcel-jest-base

#### Comandos creados en package json:

#### Para instalar las dependencias:

npm install

#### Comandos de uso:

Ejecutar web-sever local parcel:
npm start

Ejecutar Jest y guardar la ejecución local:

```sh
npm test
```

El próximo commit normal cierra el ciclo en `script/tdd-events/`. Los hooks de
Husky se instalan con `npm install`. Los resultados pendientes se guardan en el
directorio local de Git y no se incluyen en el export para la web. Termina el
ciclo antes de renombrar la rama. Si ya la renombraste con pruebas pendientes,
restaura el nombre anterior para recuperar el ciclo.

### Vista local y export para TDDLab

Si la práctica ya tiene historial, usa el **SHA completo del último commit con
los JSON antiguos, antes de activar la captura por ciclos**. Reutiliza siempre
ese mismo SHA. En una práctica nueva, usa `--no-legacy` en ambos comandos.

```sh
npm run tdd:preview -- --legacy <SHA>
npm run tdd:export -- <carpeta-fuera-del-repo> <url-https-del-repo> --legacy <SHA>
```

El primer comando actualiza la vista local de la extensión, incluyendo los tests
pendientes de la rama. Vuelve a ejecutarlo al cambiar de rama o después de probar.
El segundo lee los ciclos confirmados en `HEAD`; ejecútalo desde el commit integrado
con un clon de historial completo y una carpeta de salida nueva. El export
incluye los padres y la fecha de hasta 60 commits recientes para la Lista de Commits.
Cuando la captura tiene un nombre de rama, también indica en qué rama se ejecutaron
las pruebas. Si falta ese dato, la lista indica la rama del historial exportado
cuando se conoce.

Revisa `tdd-review.json` antes de publicar: enumera registros del histórico que no
pudieron asociarse con certeza. Los originales siguen disponibles en el SHA
indicado. Para publicar, copia solo los dos JSON de `script/` a sus rutas
habituales en `main` y súbelos en un mismo commit. Usa `HUSKY_SKIP_TRACK=1` en ese
commit para que el hook no cierre ejecuciones pendientes. Un squash asocia sus
ciclos al SHA integrado del squash.
