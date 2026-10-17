/** Navigation belongs to the host, whether it is Tasks or the Todoist extension. */
export interface TaskDestination {
  name: string;
  taskHref: (id: string) => string;
  projectHref: (id: string) => string;
}
