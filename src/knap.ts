import { createEngine, standardFilters, type TemplateFilter } from "knap";
import { parseYaml, stringifyYaml } from "obsidian";

const knapProperty = standardFilters.yaml_property;

const yamlProperty: TemplateFilter = (value, param, context) => {
  const written = knapProperty(value, param, context);

  if (typeof written !== "string") return written;

  try {
    const property: unknown = parseYaml(written);

    return typeof property === "object" && property !== null ? stringifyYaml(property).trimEnd() : written;
  } catch {
    return written;
  }
};

yamlProperty.metadata = knapProperty.metadata;

export const engine = createEngine({ filters: { ...standardFilters, yaml_property: yamlProperty } });

export function describeError(error: { line: number; column: number; message: string }): string {
  return `Line ${error.line}, column ${error.column}: ${error.message}`;
}
