package main

import pb "github.com/ziyixi/protos/go/todofy"

var (
	llmModelNames = map[pb.Model]string{
		pb.Model_MODEL_GEMINI_2_0_PRO_EXP_02_05: "gemini-2.0-pro-exp-02-05",
		pb.Model_MODEL_GEMINI_1_5_PRO:           "gemini-1.5-pro",
		pb.Model_MODEL_GEMINI_2_0_FLASH:         "gemini-2.0-flash",
		pb.Model_MODEL_GEMINI_1_5_FLASH:         "gemini-1.5-flash",
	}
	llmModelPriority = []pb.Model{
		pb.Model_MODEL_GEMINI_2_0_PRO_EXP_02_05,
		pb.Model_MODEL_GEMINI_1_5_PRO,
		pb.Model_MODEL_GEMINI_2_0_FLASH,
		pb.Model_MODEL_GEMINI_1_5_FLASH,
	}
	supportedModelFamily = []pb.ModelFamily{
		pb.ModelFamily_MODEL_FAMILY_GEMINI,
	}
)

const (
	tokenLimit int32 = 1048576 // 10k tokens, gemini-2.0-flash
)
