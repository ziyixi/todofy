package utils

// Key constants used throughout the application for context storage
const (
	// KeyGRPCClients is the context key for storing gRPC clients
	KeyGRPCClients                       = "grpcClients"
	SystemAutomaticallyEmailPrefix       = "[Todofy System]"
	SystemAutomaticallyEmailSender       = "me@ziyixi.science"
	SystemAutomaticallyEmailReceiver     = "xiziyi2015@gmail.com"
	SystemAutomaticallyEmailReceiverName = "Ziyi Xi"

	DefaultpromptToSummaryEmail string = `Could you please provide a concise and comprehensive summary of the given ` +
		`email? The summary should capture the main points and key details of the text while conveying the ` +
		`author's intended meaning accurately. Please ensure that the summary is well-organized and easy to read, ` +
		`with clear headings and subheadings to guide the reader through each section. The length of the ` +
		`summary should be appropriate to capture the main points and key details of the text, without ` +
		`including unnecessary information or becoming overly long. 
	
	IMPORTANT: Please do not write something like "OK, this is my summary". Just start with the summary.
	IMPORTANT: Try to follow markdown formatting as much as possible.
	IMPORTANT: Please use chinese as response language.
	IMPORTANT: Please try to be concise to 1-2 sentences.
	IMPORTANT: Avoid showing # symbol in the summary.

	The email content you are to summarize is as follows:`

	DefaultpromptToSummaryEmailRange string = `Below is all of emails I received today and summarized ` +
		`by previous gemini API call. Please rank them in order (ranked by importance you think), summary ` +
		`to a brief one sentense each item. So I can have a brief overview of the emails at the start of the morning.

	IMPORTANT: Please do not write something like "OK, this is my summary". Just start with the summary.
	IMPORTANT: Try to follow the format that is readable for mac email app (no markdown).
	IMPORTANT: Don't use double quotes for the email subject. Just use plain text.
	IMPORTANT: Please group emails into four categories: "Important", "Urgent", "Normal", "Low Priority". ` +
		`If you think the email is not important, please put it into "Low Priority" category.
	IMPORTANT: Similar emails should be treated as one email.

	All the emails previous summarized by gemini API are as follows:`

	DefaultPromptToRecommendTopTasks string = `Below is a list of task summaries I received in the last 24 hours. ` +
		`Based on these tasks, please pick exactly THREE that are the most important and require my immediate attention. ` +
		`For each of the three tasks, provide a title and a reason.

Rank them from most important (#1) to least important (#3).

IMPORTANT: You MUST respond with ONLY a valid JSON array, no other text before or after.
IMPORTANT: Each element must have exactly these fields:
  "rank" (integer 1-3), "title" (string, one-line), "reason" (string, 1-2 sentences).
IMPORTANT: Output exactly 3 items. If there are fewer than 3 tasks, re-emphasize the same task and note it.
IMPORTANT: Please use Chinese as response language for title and reason.
IMPORTANT: Keep each reason concise.

Example output format:
[{"rank":1,"title":"任务标题","reason":"原因说明"},
{"rank":2,"title":"任务标题","reason":"原因说明"},
{"rank":3,"title":"任务标题","reason":"原因说明"}]

The task summaries from the last 24 hours are as follows:`
)
