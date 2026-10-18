import { useState, type ReactElement } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Star,
} from "lucide-react";
import { api, describeError, type Catalog, type CatalogKind } from "../api";
import "./task-menus.css";

type Item =
  | Catalog["projects"][number]
  | Catalog["labels"][number]
  | Catalog["filters"][number];
type Kind = Exclude<CatalogKind, "section">;

export function CatalogMenu({
  kind,
  item,
  children,
  onEdit,
  onSaved,
  onError,
}: {
  kind: Kind;
  item: Item;
  children?: ReactElement;
  onEdit: () => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function change(action: "favorite" | "archive") {
    setBusy(true);
    try {
      const requestId = crypto.randomUUID();
      if (action === "archive" && kind === "project" && "archived" in item) {
        await api.updateProject({
          requestId,
          etag: item.etag,
          project: { name: item.name, archived: !item.archived },
          updateMask: { paths: ["archived"] },
        });
      } else {
        const resource = { name: item.name, favorite: !item.favorite };
        const common = {
          requestId,
          etag: item.etag,
          updateMask: { paths: ["favorite"] },
        };
        if (kind === "project")
          await api.updateProject({ ...common, project: resource });
        else if (kind === "label")
          await api.updateLabel({ ...common, label: resource });
        else await api.updateSavedFilter({ ...common, savedFilter: resource });
      }
      await onSaved();
    } catch (reason) {
      onError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  const items = (
    <>
      <Menu.Item className="task-menu-item" onClick={onEdit}>
        <Pencil size={15} />
        Edit
      </Menu.Item>
      <Menu.Item
        className="task-menu-item"
        disabled={busy}
        onClick={() => void change("favorite")}
      >
        <Star size={15} />
        {item.favorite ? "Remove from favorites" : "Add to favorites"}
      </Menu.Item>
      {kind === "project" && "archived" in item && !item.inbox && (
        <>
          <Menu.Separator className="task-menu-separator" />
          <Menu.Item
            className="task-menu-item"
            disabled={busy}
            onClick={() => void change("archive")}
          >
            {item.archived ? (
              <ArchiveRestore size={15} />
            ) : (
              <Archive size={15} />
            )}
            {item.archived ? "Unarchive" : "Archive"}
          </Menu.Item>
        </>
      )}
    </>
  );
  if (children)
    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger render={children} />
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="task-menu-positioner">
            <ContextMenu.Popup
              className="task-menu-popup"
              aria-label={`Actions for ${item.title}`}
            >
              {items}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  return (
    <Menu.Root>
      <Menu.Trigger
        className="icon-button catalog-more-button"
        aria-label={`More actions for ${item.title}`}
      >
        <MoreHorizontal size={17} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          align="end"
          sideOffset={5}
          className="task-menu-positioner"
        >
          <Menu.Popup
            className="task-menu-popup"
            aria-label={`Actions for ${item.title}`}
          >
            {items}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
