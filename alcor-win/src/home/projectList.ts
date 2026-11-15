import { swiftDateToJsDate } from "../model";
import { projectEntryName, type ProjectEntry } from "../project/projectRegistry";

export type ProjectSort = "lastOpened" | "created" | "name";

export const projectSortLabels: Record<ProjectSort, string> = {
  lastOpened: "Last Opened",
  created: "Date Created",
  name: "Name",
};

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** `localizedStandardContains`: case- and diacritic-insensitive substring match. */
export function standardContains(haystack: string, needle: string): boolean {
  return fold(haystack).includes(fold(needle));
}

export function sortProjects(entries: ProjectEntry[], sort: ProjectSort): ProjectEntry[] {
  const out = [...entries];
  switch (sort) {
    case "lastOpened": return out.sort((a, b) => b.lastOpenedDate - a.lastOpenedDate);
    case "created": return out.sort((a, b) => b.createdDate - a.createdDate);
    case "name":
      return out.sort((a, b) =>
        projectEntryName(a).localeCompare(projectEntryName(b), undefined, { numeric: true, sensitivity: "base" }),
      );
  }
}

/** Sorted entries whose name contains the trimmed query (all of them for a blank query). */
export function filterProjects(entries: ProjectEntry[], query: string, sort: ProjectSort): ProjectEntry[] {
  const sorted = sortProjects(entries, sort);
  const q = query.trim();
  return q === "" ? sorted : sorted.filter((e) => standardContains(projectEntryName(e), q));
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

const formatter = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "long" });

/** `RelativeDateTimeFormatter` (full units): "3 days ago", "in 2 hours", "now". */
export function relativeString(date: Date, now: Date = new Date()): string {
  const seconds = Math.trunc((date.getTime() - now.getTime()) / 1000);
  if (seconds === 0) return "now";
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size || unit === "second") return formatter.format(Math.trunc(seconds / size), unit);
  }
  return "now";
}

export function relativeStringForSwiftDate(date: number, now: Date = new Date()): string {
  return relativeString(swiftDateToJsDate(date), now);
}
