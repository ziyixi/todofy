import { useState } from "react";
import {
  Archive,
  Hash,
  ListFilter,
  Pencil,
  Plus,
  Star,
  Tag,
} from "lucide-react";
import type { Catalog, CatalogItem, CatalogKind } from "../api";
import { routeHref } from "../routes";

export function CatalogView({
  catalog,
  onEdit,
}: {
  catalog: Catalog;
  onEdit: (kind: CatalogKind, item?: CatalogItem) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const groups = [
    {
      kind: "project" as const,
      title: "Projects",
      items: catalog.projects.filter((item) => item.archived === showArchived),
      icon: Hash,
    },
    {
      kind: "label" as const,
      title: "Labels",
      items: catalog.labels,
      icon: Tag,
    },
    {
      kind: "filter" as const,
      title: "Filters",
      items: catalog.filters,
      icon: ListFilter,
    },
  ];
  return (
    <div className="catalog-view">
      <header className="view-header">
        <h1>Projects, labels &amp; filters</h1>
      </header>
      {groups.map(({ kind, title, items, icon: Icon }) => (
        <section key={kind}>
          <header className="catalog-heading">
            <h2>{title}</h2>
            {kind === "project" && (
              <button
                className={`text-button ${showArchived ? "active" : ""}`}
                onClick={() => setShowArchived((value) => !value)}
              >
                <Archive size={14} />
                {showArchived ? "Archived" : "Show archived"}
              </button>
            )}
            <button
              className="icon-button"
              onClick={() => onEdit(kind)}
              aria-label={`Add ${kind}`}
            >
              <Plus size={17} />
            </button>
          </header>
          {items.length === 0 && (
            <p className="muted catalog-empty">
              {showArchived && kind === "project"
                ? "No archived projects."
                : `No ${title.toLowerCase()} yet.`}
            </p>
          )}
          {items.map((item) => (
            <div className="catalog-row" key={item.id}>
              <a
                href={routeHref({
                  page: kind === "project" ? "project" : kind,
                  id: item.id,
                })}
              >
                <Icon
                  size={18}
                  style={{ color: "color" in item ? item.color : undefined }}
                />
                <span>
                  {item.title}
                  {"query" in item && <small>{item.query}</small>}
                </span>
                {item.favorite && <Star size={13} />}
              </a>
              <button
                className="icon-button"
                onClick={() => onEdit(kind, item)}
                aria-label={`Edit ${item.title}`}
              >
                <Pencil size={15} />
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
