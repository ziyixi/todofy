import { useState, type FormEvent } from "react";
import {
  api,
  describeError,
  type Catalog,
  type CatalogItem,
  type CatalogKind,
} from "../api";
import { Dialog } from "./Dialog";

const names: Record<CatalogKind, string> = {
  project: "project",
  section: "section",
  label: "label",
  filter: "filter",
};
const deleteConsequences: Record<CatalogKind, string> = {
  project: "Its tasks, sections and subprojects will also be deleted. Archive it to keep them.",
  section: "All tasks in this section will also be deleted.",
  label: "It will be removed from tasks; the tasks will stay.",
  filter: "The saved view will be removed; tasks will stay.",
};
export function CatalogEditor({
  kind,
  item,
  catalog,
  projectId = "",
  onClose,
  onSaved,
}: {
  kind: CatalogKind;
  item?: CatalogItem;
  catalog: Catalog;
  projectId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [title, setTitle] = useState(item?.title || "");
  const [color, setColor] = useState(
    item && "color" in item ? item.color || "#808b73" : "#808b73",
  );
  const [favorite, setFavorite] = useState(
    item && "favorite" in item ? item.favorite : false,
  );
  const [archived, setArchived] = useState(
    item && "archived" in item ? item.archived : false,
  );
  const [parentId, setParentId] = useState(
    item && "parentId" in item ? item.parentId : "",
  );
  const [ownerProjectId, setOwnerProjectId] = useState(
    item && "projectId" in item ? item.projectId : projectId,
  );
  const [query, setQuery] = useState(item && "query" in item ? item.query : "");
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const base = { title: title.trim(), name: item?.name, etag: item?.etag };
    try {
      if (kind === "project") {
        const project = { ...base, color, favorite, archived, parentId };
        if (item)
          await api.updateProject({
            etag: item.etag,
            requestId,
            project,
            updateMask: {
              paths: ["title", "color", "favorite", "archived", "parent_id"],
            },
          });
        else await api.createProject({ requestId, projectId: requestId, project });
      } else if (kind === "section") {
        const section = { ...base, projectId: ownerProjectId };
        if (item)
          await api.updateSection({
            etag: item.etag,
            requestId,
            section,
            updateMask: { paths: ["title", "project_id"] },
          });
        else await api.createSection({ requestId, sectionId: requestId, section });
      } else if (kind === "label") {
        const label = { ...base, color, favorite };
        if (item)
          await api.updateLabel({
            etag: item.etag,
            requestId,
            label,
            updateMask: { paths: ["title", "color", "favorite"] },
          });
        else await api.createLabel({ requestId, labelId: requestId, label });
      } else {
        const savedFilter = { ...base, query, favorite };
        if (item)
          await api.updateSavedFilter({
            etag: item.etag,
            requestId,
            savedFilter,
            updateMask: { paths: ["title", "query", "favorite"] },
          });
        else await api.createSavedFilter({ requestId, savedFilterId: requestId, savedFilter });
      }
      await onSaved();
      onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!item) return;
    setBusy(true);
    setError("");
    const input = {
      name: item.name,
      etag: item.etag,
      requestId: crypto.randomUUID(),
    };
    try {
      if (kind === "project") await api.deleteProject(input);
      else if (kind === "section") await api.deleteSection(input);
      else if (kind === "label") await api.deleteLabel(input);
      else await api.deleteSavedFilter(input);
      await onSaved();
      onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`${item ? "Edit" : "Add"} ${names[kind]}`}
      onClose={onClose}
      className="catalog-dialog"
    >
      <form onSubmit={save} className="catalog-form">
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <label>
          Name
          <input
            autoFocus
            data-autofocus
            required
            maxLength={100}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {(kind === "project" || kind === "label") && (
          <label>
            Color
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
            />
          </label>
        )}
        {kind === "project" && (
          <>
            <label>
              Parent project
              <select
                value={parentId}
                onChange={(event) => setParentId(event.target.value)}
              >
                <option value="">No parent</option>
                {catalog.projects
                  .filter(
                    (project) => project.id !== item?.id && !project.archived,
                  )
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
              </select>
            </label>
            {item && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(event) => setArchived(event.target.checked)}
                />
                Archived
              </label>
            )}
          </>
        )}
        {kind === "section" && (
          <label>
            Project
            <select
              required
              value={ownerProjectId}
              onChange={(event) => setOwnerProjectId(event.target.value)}
            >
              <option value="" disabled>
                Select project
              </option>
              {catalog.projects
                .filter((project) => !project.archived)
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        {kind === "filter" && (
          <>
            <label>
              Query
              <textarea
                required
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                rows={3}
                placeholder="@waiting & !@blocked"
              />
            </label>
            <p className="field-hint">
              Use labels (@), projects (#), priority, dates and &amp;, |, !.
              Commas separate groups.
            </p>
          </>
        )}
        {kind !== "section" && (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={favorite}
              onChange={(event) => setFavorite(event.target.checked)}
            />
            Add to favorites
          </label>
        )}
        <footer className="dialog-footer">
          {item && (
            <button
              type="button"
              className="text-button danger"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={busy || !title.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
        {confirmDelete && (
          <div className="delete-confirm">
            <p>
              Delete this {names[kind]}?{" "}
              {deleteConsequences[kind]}
            </p>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setConfirmDelete(false)}
            >
              Keep
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete {names[kind]}
            </button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
