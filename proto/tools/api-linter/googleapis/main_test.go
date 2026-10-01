package main

import (
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
)

// compiled is the compiled copy of one googleapis file, as buf would write it into an image: with json_name on every
// field and buf's module record as an unknown field.
func compiled(t *testing.T, name string) *descriptorpb.FileDescriptorProto {
	t.Helper()
	file, err := protoregistry.GlobalFiles.FindFileByPath(name)
	if err != nil {
		t.Fatal(err)
	}
	copied := protodesc.ToFileDescriptorProto(file)
	for _, message := range copied.MessageType {
		for _, field := range message.Field {
			field.JsonName = proto.String("x" + field.GetName())
		}
	}
	copied.ProtoReflect().SetUnknown([]byte{0xd2, 0xf6, 0x03, 0x01, 0x00}) // field 8042, bytes "\x00"
	return copied
}

func image(files ...*descriptorpb.FileDescriptorProto) *descriptorpb.FileDescriptorSet {
	return &descriptorpb.FileDescriptorSet{File: files}
}

func problems(results []Result) map[string]string {
	found := map[string]string{}
	for _, result := range results {
		found[result.Name] = result.Problem
	}
	return found
}

func TestTheSameFilesMatch(t *testing.T) {
	results := Compare(image(compiled(t, "google/api/field_behavior.proto"), compiled(t, "google/api/http.proto")), protoregistry.GlobalFiles)
	want := map[string]string{"google/api/field_behavior.proto": "", "google/api/http.proto": ""}
	if got := problems(results); len(got) != len(want) || got["google/api/field_behavior.proto"] != "" || got["google/api/http.proto"] != "" {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestAnotherVersionOfAFileFails(t *testing.T) {
	// A googleapis bump that adds a FieldBehavior value: the linter would not know it.
	changed := compiled(t, "google/api/field_behavior.proto")
	changed.EnumType[0].Value = append(changed.EnumType[0].Value, &descriptorpb.EnumValueDescriptorProto{Name: proto.String("NEW_BEHAVIOR"), Number: proto.Int32(99)})
	if got := problems(Compare(image(changed), protoregistry.GlobalFiles)); got["google/api/field_behavior.proto"] == "" {
		t.Fatalf("a changed file passed: %v", got)
	}
}

func TestAFileTheLinterLacksFailsOnlyWithExtensions(t *testing.T) {
	plain := &descriptorpb.FileDescriptorProto{Name: proto.String("google/type/example.proto"), Package: proto.String("google.type")}
	annotations := &descriptorpb.FileDescriptorProto{
		Name:      proto.String("google/api/example.proto"),
		Package:   proto.String("google.api"),
		Extension: []*descriptorpb.FieldDescriptorProto{{Name: proto.String("example"), Number: proto.Int32(99999), Extendee: proto.String(".google.protobuf.FieldOptions")}},
	}
	got := problems(Compare(image(plain, annotations), protoregistry.GlobalFiles))
	if got["google/type/example.proto"] != "" || got["google/api/example.proto"] == "" {
		t.Fatalf("got %v", got)
	}
}

func TestOnlyGoogleapisFilesAreChecked(t *testing.T) {
	own := &descriptorpb.FileDescriptorProto{Name: proto.String("lab/ui/v1/deck.proto")}
	wkt := &descriptorpb.FileDescriptorProto{Name: proto.String("google/protobuf/timestamp.proto")}
	if got := Compare(image(own, wkt), protoregistry.GlobalFiles); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}
