package main

import pb "github.com/ziyixi/protos/go/todofy"

var (
	llmModelNames = map[pb.Model]string{
		pb.Model_MODEL_GEMINI_2_0_FLASH:               "gemini-2.0-flash",
		pb.Model_MODEL_GEMINI_2_5_PRO_EXP_03_25:       "gemini-2.5-pro-exp-03-25",
		pb.Model_MODEL_GEMINI_2_5_FLASH_PREVIEW_04_17: "gemini-2.5-flash-preview-04-17",
		pb.Model_MODEL_GEMINI_2_0_FLASH_LITE:          "gemini-2.0-flash-lite",
	}
	llmModelPriority = []pb.Model{
		pb.Model_MODEL_GEMINI_2_5_PRO_EXP_03_25,
		pb.Model_MODEL_GEMINI_2_5_FLASH_PREVIEW_04_17,
		pb.Model_MODEL_GEMINI_2_0_FLASH,
		pb.Model_MODEL_GEMINI_2_0_FLASH_LITE,
	}
	supportedModelFamily = []pb.ModelFamily{
		pb.ModelFamily_MODEL_FAMILY_GEMINI,
	}
)

const (
	tokenLimit int32 = 1048576 // 10k tokens, gemini-2.0-flash
)
