/** Tests de la réplica de color del grafo (decisión del frontend). */
import { projectCommitColor } from "./lib/graphParity.js";

const base = (over = {}) => ({
  coverage: 0.8,
  test_count: 10,
  conclusion: "success",
  commit: { message: "feat: algo" },
  ...over,
});

describe("projectCommitColor", () => {
  it("pinta negro cuando no hay cobertura (desconocido)", () => {
    expect(projectCommitColor(base({ coverage: null }))).toBe("black");
    expect(projectCommitColor(base({ coverage: undefined }))).toBe("black");
  });

  it("pinta rojo cuando no hay tests", () => {
    expect(projectCommitColor(base({ test_count: 0 }))).toBe("red");
    expect(projectCommitColor(base({ test_count: null }))).toBe("red");
    expect(projectCommitColor(base({ test_count: undefined }))).toBe("red");
  });

  it("pinta rojo cuando la cobertura es 0", () => {
    expect(projectCommitColor(base({ coverage: 0 }))).toBe("red");
  });

  it("pinta rojo cuando la ejecución falló", () => {
    expect(projectCommitColor(base({ conclusion: "failure" }))).toBe("red");
  });

  it("pinta azul en commits de refactor", () => {
    expect(projectCommitColor(base({ commit: { message: "refactor: limpiar" } }))).toBe("blue");
    expect(projectCommitColor(base({ commit: { message: "Refactoring tests" } }))).toBe("blue");
  });

  it("pinta verde en un commit verde normal", () => {
    expect(projectCommitColor(base())).toBe("green");
  });

  it("un commit verde sin cobertura NO se pinta verde (negro primero)", () => {
    expect(projectCommitColor(base({ coverage: null, commit: { message: "refactor: x" } }))).toBe("black");
  });

  it("estructura inválida => rojo (defensivo, igual que el original)", () => {
    expect(projectCommitColor(null)).toBe("red");
    expect(projectCommitColor(undefined)).toBe("red");
    expect(projectCommitColor({ coverage: 0.9 })).toBe("red");
  });
});
