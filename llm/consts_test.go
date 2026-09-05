package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	pb "github.com/ziyixi/protos/go/todofy"
)

const (
	testDefaultModelName   = "gemini-3.8-flash"
	testFirstFallbackName  = "gemini-3.7-flash"
	testSecondFallbackName = "gemini-3.5-flash-lite"
)

func TestLLMConstants(t *testing.T) {
	t.Run("llmModelNames contains expected models", func(t *testing.T) {
		expectedModels := []pb.Model{
			pb.Model_MODEL_GEMINI_2_5_PRO,
			pb.Model_MODEL_GEMINI_2_5_FLASH,
			pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
			pb.Model_MODEL_GEMINI_3_FLASH_PREVIEW,
			pb.Model_MODEL_GEMINI_3_8_FLASH,
			pb.Model_MODEL_GEMINI_3_7_FLASH,
			pb.Model_MODEL_GEMINI_3_6_FLASH,
			pb.Model_MODEL_GEMINI_3_5_FLASH,
			pb.Model_MODEL_GEMINI_3_5_FLASH_LITE,
			pb.Model_MODEL_GEMINI_3_1_FLASH_LITE,
			pb.Model_MODEL_GEMINI_3_1_PRO_PREVIEW,
		}

		for _, model := range expectedModels {
			_, exists := llmModelNames[model]
			assert.True(t, exists, "Model %v should exist in llmModelNames", model)
		}

		// Check specific mappings
		assert.Equal(t, "gemini-2.5-pro", llmModelNames[pb.Model_MODEL_GEMINI_2_5_PRO])
		assert.Equal(t, "gemini-2.5-flash", llmModelNames[pb.Model_MODEL_GEMINI_2_5_FLASH])
		assert.Equal(t, "gemini-2.5-flash-lite", llmModelNames[pb.Model_MODEL_GEMINI_2_5_FLASH_LITE])
		assert.Equal(t, "gemini-3-flash-preview", llmModelNames[pb.Model_MODEL_GEMINI_3_FLASH_PREVIEW])
	})

	t.Run("llmModelPriority has correct order", func(t *testing.T) {
		expectedPriority := []pb.Model{
			pb.Model_MODEL_GEMINI_3_8_FLASH,
			pb.Model_MODEL_GEMINI_3_7_FLASH,
			pb.Model_MODEL_GEMINI_3_5_FLASH_LITE,
		}

		assert.Equal(t, expectedPriority, llmModelPriority)
		assert.Len(t, llmModelPriority, 3)

		assert.Equal(t, pb.Model_MODEL_GEMINI_3_8_FLASH, llmModelPriority[0])
	})

	t.Run("supportedModelFamily contains Gemini", func(t *testing.T) {
		assert.Contains(t, supportedModelFamily, pb.ModelFamily_MODEL_FAMILY_GEMINI)
		assert.Len(t, supportedModelFamily, 1, "Should only support Gemini family for now")
	})

	t.Run("tokenLimit has reasonable value", func(t *testing.T) {
		assert.Equal(t, int32(1048576), tokenLimit)
		assert.Greater(t, tokenLimit, int32(0), "Token limit should be positive")
	})
}

func TestLLMModelMappings(t *testing.T) {
	t.Run("all priority models exist in model names", func(t *testing.T) {
		for _, model := range llmModelPriority {
			_, exists := llmModelNames[model]
			assert.True(t, exists, "Priority model %v should have a corresponding name mapping", model)
		}
	})

	t.Run("all model names are non-empty", func(t *testing.T) {
		for model, name := range llmModelNames {
			assert.NotEmpty(t, name, "Model name for %v should not be empty", model)
			assert.Contains(t, name, "gemini", "Model name should contain 'gemini': %s", name)
		}
	})

	t.Run("model names follow expected pattern", func(t *testing.T) {
		expectedPatterns := map[pb.Model]string{
			pb.Model_MODEL_GEMINI_2_5_PRO:         "gemini-2.5-pro",
			pb.Model_MODEL_GEMINI_2_5_FLASH:       "gemini-2.5-flash",
			pb.Model_MODEL_GEMINI_2_5_FLASH_LITE:  "gemini-2.5-flash-lite",
			pb.Model_MODEL_GEMINI_3_FLASH_PREVIEW: "gemini-3-flash-preview",
			pb.Model_MODEL_GEMINI_3_8_FLASH:       testDefaultModelName,
			pb.Model_MODEL_GEMINI_3_7_FLASH:       testFirstFallbackName,
			pb.Model_MODEL_GEMINI_3_6_FLASH:       "gemini-3.6-flash",
			pb.Model_MODEL_GEMINI_3_5_FLASH:       "gemini-3.5-flash",
			pb.Model_MODEL_GEMINI_3_5_FLASH_LITE:  testSecondFallbackName,
			pb.Model_MODEL_GEMINI_3_1_FLASH_LITE:  "gemini-3.1-flash-lite",
			pb.Model_MODEL_GEMINI_3_1_PRO_PREVIEW: "gemini-3.1-pro-preview",
		}

		assert.Equal(t, expectedPatterns, llmModelNames)

		for model, expectedName := range expectedPatterns {
			actualName, exists := llmModelNames[model]
			assert.True(t, exists, "Model %v should exist", model)
			assert.Equal(t, expectedName, actualName, "Model name should match expected pattern")
		}
	})
}

func TestModelFamilySupport(t *testing.T) {
	t.Run("only Gemini family is supported", func(t *testing.T) {
		assert.Len(t, supportedModelFamily, 1)
		assert.Equal(t, pb.ModelFamily_MODEL_FAMILY_GEMINI, supportedModelFamily[0])
	})

	t.Run("supported family is valid", func(t *testing.T) {
		for _, family := range supportedModelFamily {
			assert.NotEqual(t, pb.ModelFamily_MODEL_FAMILY_UNSPECIFIED, family)
		}
	})
}

func TestLLMModelWireCompatibility(t *testing.T) {
	// Numeric values are persisted in data and sent over gRPC; never renumber them.
	expectedValues := map[string]int32{
		"MODEL_GEMINI_2_5_PRO":         8,
		"MODEL_GEMINI_2_5_FLASH":       9,
		"MODEL_GEMINI_2_5_FLASH_LITE":  10,
		"MODEL_GEMINI_3_FLASH_PREVIEW": 11,
		"MODEL_GEMINI_3_8_FLASH":       12,
		"MODEL_GEMINI_3_7_FLASH":       13,
		"MODEL_GEMINI_3_6_FLASH":       14,
		"MODEL_GEMINI_3_5_FLASH":       15,
		"MODEL_GEMINI_3_5_FLASH_LITE":  16,
		"MODEL_GEMINI_3_1_FLASH_LITE":  17,
		"MODEL_GEMINI_3_1_PRO_PREVIEW": 18,
	}
	for name, value := range expectedValues {
		assert.Equal(t, value, pb.Model_value[name], name)
		assert.Equal(t, name, pb.Model(value).String())
	}
}
