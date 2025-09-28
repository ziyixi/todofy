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
)
