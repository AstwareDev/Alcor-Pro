export type ProjectErrorKind = "nameTaken" | "invalidName" | "openProjects" | "missingTimeline";

/** Port of AppState's `ProjectError`, plus the missing-`project.json` failure of `requiredData`. */
export class ProjectError extends Error {
  readonly kind: ProjectErrorKind;

  constructor(kind: ProjectErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectError";
    this.kind = kind;
  }
}

export const projectErrors = {
  nameTaken: (name: string) =>
    new ProjectError("nameTaken", `A project named “${name}” already exists in that folder. Pick another name.`),
  invalidName: (name: string) =>
    new ProjectError(
      "invalidName",
      `“${name}” isn't a valid project name. Use a plain name without slashes or path components.`,
    ),
  openProjects: (names: string[]) =>
    new ProjectError("openProjects", `Close ${new Intl.ListFormat("en", { type: "conjunction" }).format(names)} before deleting.`),
  missingTimeline: (packagePath: string, cause: unknown) =>
    new ProjectError("missingTimeline", `Missing project.json in ${packagePath}.`, { cause }),
};
