package main

import pb "github.com/ziyixi/protos/go/todofy"

const (
	sender       = "ziyixi@mailjet.ziyixi.science"
	senderName   = "Todofy"
	receiverName = "dida365"
)

var (
	allowedPopullateTodoMethod = map[pb.TodoApp][]pb.PopullateTodoMethod{
		pb.TodoApp_TODO_APP_DIDA365: {pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET},
		pb.TodoApp_TODO_APP_NOTION:  {pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION},
		pb.TodoApp_TODO_APP_TODOIST: {pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST},
	}
)
