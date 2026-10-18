import { ListFilter, Plus, Star, Tag } from "lucide-react";
import type { Catalog, CatalogItem, CatalogKind } from "../api";
import { routeHref } from "../routes";
import { CatalogMenu } from "./CatalogMenu";

export function CatalogView({
  catalog,
  onEdit,
  onSaved,
  onError,
}: {
  catalog: Catalog;
  onEdit: (kind: CatalogKind, item?: CatalogItem) => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const groups = [
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
        <h1>Labels &amp; filters</h1>
      </header>
      {groups.map(({ kind, title, items, icon: Icon }) => (
        <section key={kind}>
          <header className="catalog-heading">
            <h2>{title}</h2>
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
              {`No ${title.toLowerCase()} yet.`}
            </p>
          )}
          {items.map((item) => {
            const count = catalog.taskCounts?.find(
              (entry) => entry.view === kind && entry.id === item.id,
            )?.count;
            return (
              <CatalogMenu
                key={item.id}
                kind={kind}
                item={item}
                onEdit={() => onEdit(kind, item)}
                onSaved={onSaved}
                onError={onError}
              >
                <div className="catalog-row">
                  <a
                    href={routeHref({
                      page: kind,
                      id: item.id,
                    })}
                  >
                    <Icon
                      size={18}
                      style={{
                        color: "color" in item ? item.color : undefined,
                      }}
                    />
                    <span>
                      {item.title}
                      {"query" in item && <small>{item.query}</small>}
                    </span>
                    {count !== undefined && (
                      <span className="category-count" aria-hidden="true">
                        {count}
                      </span>
                    )}
                    {item.favorite && <Star size={13} />}
                  </a>
                  <CatalogMenu
                    kind={kind}
                    item={item}
                    onEdit={() => onEdit(kind, item)}
                    onSaved={onSaved}
                    onError={onError}
                  />
                </div>
              </CatalogMenu>
            );
          })}
        </section>
      ))}
    </div>
  );
}
