// Command googleapis checks that api-linter reads the module with the googleapis that buf.lock pins.
//
// api-linter interprets the google.api annotations (field_behavior, resource, http, field_info, ...) through the
// googleapis Go code compiled into it (google.golang.org/genproto, pinned in ../go.mod), while buf compiles the
// module, and protoc-gen-es generates the TypeScript, against the googleapis commit buf.lock pins. The two are
// separate pins of the same files, bumped together. This command reads buf's image of the module (with its imports)
// and fails unless every googleapis file there (google/..., but not google/protobuf/: the well-known types are no
// annotations) equals the copy compiled into this module's api-linter, or defines no extension the linter could
// need to interpret. Run by ../../../scripts/api-lint.sh before the linter:
//
//	googleapis-check <image.binpb>
package main

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"

	// The googleapis packages api-linter v2 imports (each registers its .proto files): its compiled copy.
	_ "cloud.google.com/go/longrunning/autogen/longrunningpb"
	_ "google.golang.org/genproto/googleapis/api/annotations"
	_ "google.golang.org/genproto/googleapis/api/httpbody"
	_ "google.golang.org/genproto/googleapis/type/date"
	_ "google.golang.org/genproto/googleapis/type/datetime"
	_ "google.golang.org/genproto/googleapis/type/timeofday"
)

// Result is the verdict on one googleapis file of the image.
type Result struct {
	Name string
	// Problem is empty when the file matches (or needs no compiled copy), else why not.
	Problem string
}

// isGoogleapis reports whether an image file comes from the googleapis dependency.
func isGoogleapis(name string) bool {
	return strings.HasPrefix(name, "google/") && !strings.HasPrefix(name, "google/protobuf/")
}

// normalized is a copy of file without what differs only by its producer: source info, the unknown fields buf adds
// to a file of its image (the module and commit it came from), and json_name (derived from the field name).
func normalized(file *descriptorpb.FileDescriptorProto) *descriptorpb.FileDescriptorProto {
	copied := proto.Clone(file).(*descriptorpb.FileDescriptorProto)
	copied.SourceCodeInfo = nil
	copied.ProtoReflect().SetUnknown(nil)
	clear := func(fields []*descriptorpb.FieldDescriptorProto) {
		for _, field := range fields {
			field.JsonName = nil
		}
	}
	var messages func([]*descriptorpb.DescriptorProto)
	messages = func(list []*descriptorpb.DescriptorProto) {
		for _, message := range list {
			clear(message.Field)
			clear(message.Extension)
			messages(message.NestedType)
		}
	}
	messages(copied.MessageType)
	clear(copied.Extension)
	return copied
}

// definesExtensions reports whether a file declares an extension (an annotation api-linter may interpret).
func definesExtensions(file *descriptorpb.FileDescriptorProto) bool {
	if len(file.Extension) > 0 {
		return true
	}
	var nested func([]*descriptorpb.DescriptorProto) bool
	nested = func(list []*descriptorpb.DescriptorProto) bool {
		for _, message := range list {
			if len(message.Extension) > 0 || nested(message.NestedType) {
				return true
			}
		}
		return false
	}
	return nested(file.MessageType)
}

// Compare checks every googleapis file of image against files, the compiled copy.
func Compare(image *descriptorpb.FileDescriptorSet, files *protoregistry.Files) []Result {
	var results []Result
	for _, file := range image.File {
		name := file.GetName()
		if !isGoogleapis(name) {
			continue
		}
		compiled, err := files.FindFileByPath(name)
		switch {
		case err != nil && definesExtensions(file):
			results = append(results, Result{name, "defines extensions but is not compiled into api-linter"})
		case err != nil:
			results = append(results, Result{name, ""}) // no annotation to interpret
		case !proto.Equal(normalized(protodesc.ToFileDescriptorProto(compiled)), normalized(file)):
			results = append(results, Result{name, "differs from api-linter's compiled copy"})
		default:
			results = append(results, Result{name, ""})
		}
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Name < results[j].Name })
	return results
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: googleapis-check <image.binpb>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "googleapis-check:", err)
		os.Exit(2)
	}
	image := &descriptorpb.FileDescriptorSet{}
	if err := proto.Unmarshal(data, image); err != nil {
		fmt.Fprintln(os.Stderr, "googleapis-check:", err)
		os.Exit(2)
	}
	results := Compare(image, protoregistry.GlobalFiles)
	failed := 0
	for _, result := range results {
		if result.Problem != "" {
			failed++
			fmt.Fprintf(os.Stderr, "googleapis-check: %s %s\n", result.Name, result.Problem)
		}
	}
	if failed > 0 {
		fmt.Fprintln(os.Stderr, "googleapis-check: api-linter would read these annotations with another googleapis than buf.lock's. "+
			"Bump google.golang.org/genproto/googleapis/... in tools/api-linter/go.mod (or buf.lock) until both carry the same files.")
		os.Exit(1)
	}
	if len(results) == 0 {
		fmt.Fprintln(os.Stderr, "googleapis-check: no googleapis file in the image (built without its imports?)")
		os.Exit(2)
	}
	fmt.Printf("googleapis: api-linter's compiled copy equals buf.lock's for the %d googleapis files the module imports\n", len(results))
}
