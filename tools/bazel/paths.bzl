"""Source labels and project-relative paths for child-package build targets."""

def source_label(value):
    """Resolve a source label in the calling BUILD package."""
    value = str(value)
    if value.startswith("@") or value.startswith("//"):
        return value
    return "//" + native.package_name() + ":" + value.removeprefix(":")

def workspace_path(value):
    """Return the workspace path of an explicitly named source file."""
    label = Label(source_label(value))
    return label.package + "/" + label.name if label.package else label.name

def relative_path(path, start):
    """Return a relative path between workspace or action directories."""
    parts = path.split("/") if path else []
    base = start.split("/") if start else []
    common = 0
    for index in range(min(len(parts), len(base))):
        if parts[index] != base[index]:
            break
        common += 1
    return "../" * (len(base) - common) + "/".join(parts[common:])

def project_path(value, project):
    """Resolve a source file as a command-line path within its project."""
    return relative_path(workspace_path(value), project)

def module_path(path, start):
    """Return an explicit relative JavaScript module specifier."""
    value = relative_path(path, start)
    return value if value.startswith(".") else "./" + value
