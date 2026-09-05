// Package llm provides constants and configuration for language model operations.
package main

import pb "github.com/ziyixi/protos/go/todofy"

var (
	llmModelNames = map[pb.Model]string{
		pb.Model_MODEL_GEMINI_2_5_PRO:         "gemini-2.5-pro",
		pb.Model_MODEL_GEMINI_2_5_FLASH:       "gemini-2.5-flash",
		pb.Model_MODEL_GEMINI_2_5_FLASH_LITE:  "gemini-2.5-flash-lite",
		pb.Model_MODEL_GEMINI_3_FLASH_PREVIEW: "gemini-3-flash-preview",
		pb.Model_MODEL_GEMINI_3_8_FLASH:       "gemini-3.8-flash",
		pb.Model_MODEL_GEMINI_3_7_FLASH:       "gemini-3.7-flash",
		pb.Model_MODEL_GEMINI_3_6_FLASH:       "gemini-3.6-flash",
		pb.Model_MODEL_GEMINI_3_5_FLASH:       "gemini-3.5-flash",
		pb.Model_MODEL_GEMINI_3_5_FLASH_LITE:  "gemini-3.5-flash-lite",
		pb.Model_MODEL_GEMINI_3_1_FLASH_LITE:  "gemini-3.1-flash-lite",
		pb.Model_MODEL_GEMINI_3_1_PRO_PREVIEW: "gemini-3.1-pro-preview",
	}
	// Unspecified-model requests use this order; explicit models do not fall back.
	llmModelPriority = []pb.Model{
		pb.Model_MODEL_GEMINI_3_8_FLASH,
		pb.Model_MODEL_GEMINI_3_7_FLASH,
		pb.Model_MODEL_GEMINI_3_5_FLASH_LITE,
	}
	supportedModelFamily = []pb.ModelFamily{
		pb.ModelFamily_MODEL_FAMILY_GEMINI,
	}
)

const (
	tokenLimit int32 = 1048576 // ~1M tokens (~1,048,576)
)
