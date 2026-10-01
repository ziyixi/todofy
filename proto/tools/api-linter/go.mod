module github.com/ziyixi/todofy/proto/tools/api-linter

go 1.26.0

toolchain go1.27.1

tool github.com/googleapis/api-linter/v2/cmd/api-linter

// api-linter's own copy of googleapis: it interprets the google.api annotations through this compiled genproto code,
// while buf compiles the module against the googleapis commit buf.lock pins. Bump the two together: googleapis/
// (googleapis-check, run by ../../scripts/api-lint.sh) fails until every googleapis file the module imports is the
// same in both.
require (
	cloud.google.com/go/longrunning v1.2.0
	google.golang.org/genproto v0.0.0-20260908043556-f8649ddbbfe6
	google.golang.org/genproto/googleapis/api v0.0.0-20260908043556-f8649ddbbfe6
	google.golang.org/protobuf v1.36.12
)

require (
	bitbucket.org/creachadair/stringset v0.0.12 // indirect
	github.com/bmatcuk/doublestar/v4 v4.10.0 // indirect
	github.com/bufbuild/protocompile v0.14.1 // indirect
	github.com/gertd/go-pluralize v0.2.1 // indirect
	github.com/googleapis/api-linter/v2 v2.4.0 // indirect
	github.com/mattn/go-runewidth v0.0.9 // indirect
	github.com/olekukonko/tablewriter v0.0.5 // indirect
	github.com/spf13/pflag v1.0.10 // indirect
	github.com/stoewer/go-strcase v1.3.1 // indirect
	golang.org/x/net v0.58.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260904194346-d0f1323225a4 // indirect
	google.golang.org/grpc v1.83.2 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)
