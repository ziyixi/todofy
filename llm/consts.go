// Package llm provides constants and configuration for language model operations.
package main

import pb "github.com/ziyixi/protos/go/todofy"

var (
	llmModelNames = map[pb.Model]string{
		pb.Model_MODEL_GEMINI_2_5_PRO:         "gemini-2.5-pro",
		pb.Model_MODEL_GEMINI_2_5_FLASH:       "gemini-2.5-flash",
		pb.Model_MODEL_GEMINI_2_5_FLASH_LITE:  "gemini-2.5-flash-lite",
		pb.Model_MODEL_GEMINI_3_FLASH_PREVIEW: "gemini-3-flash-preview",
	}
	llmModelPriority = []pb.Model{
		pb.Model_MODEL_GEMINI_2_5_FLASH_LITE,
		pb.Model_MODEL_GEMINI_2_5_FLASH,
		pb.Model_MODEL_GEMINI_3_FLASH_PREVIEW,
	}
	supportedModelFamily = []pb.ModelFamily{
		pb.ModelFamily_MODEL_FAMILY_GEMINI,
	}
)

const (
	tokenLimit int32 = 1048576 // 10k tokens, gemini-2.0-flash
)
