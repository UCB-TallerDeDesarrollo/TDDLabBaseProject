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

### Flujo de Trabajo con Ramas (Branching Workflow)

Este proyecto ahora registra el historial de commits y pruebas de forma separada para cada rama de Git. Esto te permite trabajar en diferentes funcionalidades de forma aislada sin mezclar los historiales.

Cuando termines de trabajar en una rama (ej. `feature/nueva-funcionalidad`) y la fusiones a tu rama principal (ej. `main`), debes ejecutar el siguiente comando para consolidar el historial:

```bash
node script/merge-histories.js <rama-origen> <rama-destino>
```

**Ejemplo:**

Si fusionaste la rama `feature/login` en `main`, ejecutarías:

```bash
node script/merge-histories.js feature/login main
```

Este comando moverá el historial de la rama de funcionalidad a la rama principal y limpiará los archivos de la rama de origen, manteniendo todo ordenado.
