package dependency

import "sort"

const (
	// LabelBlocked marks tasks with unmet dependencies.
	LabelBlocked = "dag_blocked"
	// LabelCycle marks tasks involved in dependency cycles.
	LabelCycle = "dag_cycle"
	// LabelBrokenDep marks tasks with unknown dependency keys.
	LabelBrokenDep = "dag_broken_dep"
	// LabelInvalidMeta marks tasks with invalid dependency metadata.
	LabelInvalidMeta = "dag_invalid_meta"
)

var reservedLabels = map[string]struct{}{
	LabelBlocked:     {},
	LabelCycle:       {},
	LabelBrokenDep:   {},
	LabelInvalidMeta: {},
}

// IsReservedLabel reports whether a label is managed by the DAG reconciler.
func IsReservedLabel(label string) bool {
	_, ok := reservedLabels[label]
	return ok
}

// ReservedLabels returns a sorted list of labels managed by the DAG reconciler.
func ReservedLabels() []string {
	labels := make([]string, 0, len(reservedLabels))
	for label := range reservedLabels {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	return labels
}
