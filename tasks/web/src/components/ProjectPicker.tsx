import { useMemo, useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, Hash, Inbox, List, Search } from "lucide-react";
import type { Catalog } from "../api";
import "./property-pickers.css";

interface Destination {
  value: string;
  label: string;
  path: string;
  projectId: string;
  sectionId: string;
  color: string;
  depth: number;
  inbox: boolean;
}

function destinations(catalog: Catalog): Destination[] {
  const projects = catalog.projects.filter((project) => !project.archived);
  const projectIds = new Set(projects.map((project) => project.id));
  const rows: Destination[] = [];
  function append(parentId: string, depth: number, path: string) {
    for (const project of projects
      .filter(
        (item) =>
          (projectIds.has(item.parentId) ? item.parentId : "") === parentId,
      )
      .sort(
        (a, b) =>
          Number(b.inbox) - Number(a.inbox) || a.sortOrder - b.sortOrder,
      )) {
      const fullPath = path ? `${path} / ${project.title}` : project.title;
      rows.push({
        value: `project:${project.id}`,
        label: project.title,
        path: fullPath,
        projectId: project.id,
        sectionId: "",
        color: project.color,
        depth,
        inbox: project.inbox,
      });
      for (const section of catalog.sections
        .filter((item) => item.projectId === project.id && !item.archived)
        .sort((a, b) => a.sortOrder - b.sortOrder)) {
        rows.push({
          value: `section:${section.id}`,
          label: section.title,
          path: `${fullPath} / ${section.title}`,
          projectId: project.id,
          sectionId: section.id,
          color: project.color,
          depth: depth + 1,
          inbox: false,
        });
      }
      append(project.id, depth + 1, fullPath);
    }
  }
  append("", 0, "");
  if (!projects.some((project) => project.inbox)) {
    rows.unshift({
      value: "project:",
      label: "Inbox",
      path: "Inbox",
      projectId: "",
      sectionId: "",
      color: "",
      depth: 0,
      inbox: true,
    });
  }
  return rows;
}

function DestinationIcon({ item }: { item: Destination }) {
  if (item.sectionId)
    return <List size={16} style={{ color: item.color || "#808080" }} />;
  if (item.inbox) return <Inbox size={16} className="destination-inbox" />;
  return <Hash size={17} style={{ color: item.color || "#808080" }} />;
}

export function ProjectPicker({
  catalog,
  projectId,
  sectionId,
  disabled,
  open,
  onOpenChange,
  onChange,
  anchor,
}: {
  catalog: Catalog;
  projectId: string;
  sectionId: string;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (projectId: string, sectionId: string) => void;
  anchor?: HTMLElement;
}) {
  const items = useMemo(() => destinations(catalog), [catalog]);
  const currentProject = catalog.projects.find(
    (project) => project.id === projectId,
  );
  const currentSection = catalog.sections.find(
    (section) => section.id === sectionId,
  );
  const selected =
    items.find((item) =>
      sectionId
        ? item.sectionId === sectionId
        : !item.sectionId && item.projectId === projectId,
    ) ??
    (currentProject
      ? {
          value: sectionId ? `section:${sectionId}` : `project:${projectId}`,
          label: currentSection?.title || currentProject.title,
          path: [currentProject.title, currentSection?.title]
            .filter(Boolean)
            .join(" / "),
          projectId,
          sectionId,
          color: currentProject.color,
          depth: 0,
          inbox: currentProject.inbox,
        }
      : items.find((item) => item.inbox));
  const portal = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  return (
    <div className="task-property">
      {!anchor && <span className="property-heading">Project</span>}
      <Combobox.Root
        items={items}
        open={open}
        onOpenChange={(next) => {
          if (next) setQuery("");
          onOpenChange(next);
        }}
        inputValue={query}
        onInputValueChange={setQuery}
        value={selected ?? null}
        itemToStringLabel={(item) => item.path}
        isItemEqualToValue={(a, b) => a.value === b.value}
        filter={(item, query) =>
          item.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        }
        onValueChange={(item) => {
          if (item) onChange(item.projectId, item.sectionId);
        }}
      >
        {!anchor && (
          <Combobox.Trigger
            className="property-trigger"
            aria-label="Project"
            disabled={disabled}
            ref={(element) => {
              portal.current = element?.closest("dialog") ?? null;
            }}
          >
            {selected && <DestinationIcon item={selected} />}
            <span className="property-value" title={selected?.path}>
              {selected?.path || "Inbox"}
            </span>
            <ChevronDown size={12} className="property-chevron" />
          </Combobox.Trigger>
        )}
        <Combobox.Portal container={anchor?.closest("dialog") ?? portal}>
          <Combobox.Positioner
            anchor={anchor}
            align="start"
            sideOffset={5}
            className="property-positioner"
          >
            <Combobox.Popup
              className="property-popup destination-popup"
              initialFocus={input}
              finalFocus={anchor ? () => anchor : true}
            >
              <div className="property-search">
                <Search size={15} />
                <Combobox.Input
                  ref={input}
                  aria-label="Search projects and sections"
                  placeholder="Search projects and sections"
                />
              </div>
              <Combobox.Empty className="property-empty">
                No matching projects or sections
              </Combobox.Empty>
              <Combobox.List className="property-options">
                {(item: Destination) => (
                  <Combobox.Item
                    key={item.value}
                    value={item}
                    className="property-option"
                    style={{ paddingLeft: 10 + item.depth * 15 }}
                  >
                    <DestinationIcon item={item} />
                    <span className="property-value">
                      {item.label}
                      {query && item.path !== item.label && (
                        <small className="destination-context">
                          {item.path.slice(0, -item.label.length - 3)}
                        </small>
                      )}
                    </span>
                    <Combobox.ItemIndicator>
                      <Check size={14} />
                    </Combobox.ItemIndicator>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}
