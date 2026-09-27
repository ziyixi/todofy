package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	logtest "github.com/sirupsen/logrus/hooks/test"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"github.com/ziyixi/todofy/testutils/mocks"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/ziyixi/protos/go/todofy"
)

func testMailEventIDN(n int) string {
	return fmt.Sprintf("f8c1e9a0-1a98-4fb8-8ca1-4c0a3e71%04d", n)
}

func insertMailInboxRow(t *testing.T, inbox *mailInbox, eventID, state, code string, attempts int, created int64) {
	t.Helper()
	_, err := inbox.db.Exec(`INSERT INTO mail_inbox_events(source_id,event_id,payload_hash,payload,state,
		summary,todo_body,attempt_count,last_error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
		inbox.sourceID, eventID, []byte("hash-"+eventID), testMailPayload("Synthetic subject"), state,
		testMailSummary, "Synthetic task body", attempts, code, created, created)
	require.NoError(t, err)
}

type mailStatusResponse struct {
	Items []struct {
		EventID   string `json:"event_id"`
		State     string `json:"state"`
		ErrorCode string `json:"error_code"`
	} `json:"items"`
	Counts         map[string]int `json:"counts"`
	AttentionCount int            `json:"attention_count"`
	LatestReminder *struct {
		Day       string `json:"day"`
		State     string `json:"state"`
		TaskID    string `json:"task_id"`
		Attempts  int    `json:"attempts"`
		ErrorCode string `json:"error_code"`
	} `json:"latest_reminder"`
}

func mailStatusRequest(t *testing.T, inbox *mailInbox, query string) (int, string, mailStatusResponse) {
	t.Helper()
	router := gin.New()
	router.GET("/api/v1/mail_inbox", inbox.handleStatus)
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/mail_inbox"+query, nil))
	var decoded mailStatusResponse
	if resp.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &decoded))
	}
	return resp.Code, resp.Body.String(), decoded
}

func TestMailInboxStatusAttentionViewAndCounts(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	now := time.Now().Unix()
	stale := now - int64((7 * time.Hour).Seconds())
	wantCounts := make(map[string]int, len(mailInboxStates))
	for _, state := range mailInboxStates {
		wantCounts[state] = 0
	}
	seed := func(n int, state, code string, attempts int, created int64) {
		insertMailInboxRow(t, inbox, testMailEventIDN(n), state, code, attempts, created)
		wantCounts[state]++
	}
	seed(101, "failed_summary", "summary_failed", 13, now-60)
	seed(102, "todo_unknown", "todo_result_unknown", 0, now-120)
	seed(103, "pending", "", 0, now)
	seed(104, "pending", "summary_failed", 5, stale)
	seed(105, "summarized", "", 0, stale-10)
	seed(106, "complete", "", 0, stale-100)
	seed(107, "ignored", "", 0, stale)
	seed(108, "todo_created", "", 0, now)

	for _, query := range []string{"", "?view=recent"} {
		code, raw, resp := mailStatusRequest(t, inbox, query)
		require.Equal(t, http.StatusOK, code)
		require.NotContains(t, raw, "Synthetic")
		require.Len(t, resp.Items, 8)
		require.Equal(t, testMailEventIDN(108), resp.Items[0].EventID)
		require.Equal(t, testMailEventIDN(103), resp.Items[1].EventID)
		require.Equal(t, wantCounts, resp.Counts)
		require.Equal(t, 4, resp.AttentionCount)
		require.Nil(t, resp.LatestReminder)
		require.Contains(t, raw, `"latest_reminder":null`)
	}
	code, raw, resp := mailStatusRequest(t, inbox, "?view=attention")
	require.Equal(t, http.StatusOK, code)
	require.NotContains(t, raw, "Synthetic")
	got := make([]string, 0, len(resp.Items))
	for _, item := range resp.Items {
		got = append(got, item.EventID)
	}
	require.Equal(t, []string{
		testMailEventIDN(105), testMailEventIDN(104), testMailEventIDN(102), testMailEventIDN(101),
	}, got)
	require.Equal(t, "summary_failed", resp.Items[1].ErrorCode)
	require.Equal(t, wantCounts, resp.Counts)
	require.Equal(t, 4, resp.AttentionCount)

	for _, query := range []string{"?view=all", "?view=ATTENTION", "?view=recent&view=attention"} {
		code, _, _ = mailStatusRequest(t, inbox, query)
		require.Equal(t, http.StatusBadRequest, code, query)
	}
}

func mailQueryPlan(t *testing.T, inbox *mailInbox, query string, args ...any) string {
	t.Helper()
	rows, err := inbox.db.Query("EXPLAIN QUERY PLAN "+query, args...)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()
	var details []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		require.NoError(t, rows.Scan(&id, &parent, &unused, &detail))
		details = append(details, detail)
	}
	require.NoError(t, rows.Err())
	return strings.Join(details, " | ")
}

// The ledger keeps every event ID forever, so the periodic attention queries
// must search only the non-terminal partial index, never the whole ledger.
func TestMailInboxAttentionQueriesUseBoundedIndexes(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	now := time.Now()
	cutoff := mailAttentionCutoff(now)
	for _, plan := range []string{
		mailQueryPlan(t, inbox, mailAttentionCountSQL, inbox.sourceID, cutoff),
		mailQueryPlan(t, inbox, mailAttentionListSQL, inbox.sourceID, cutoff, 500),
	} {
		require.Contains(t, plan, "USING INDEX mail_inbox_active (source_id=?)")
		require.NotContains(t, plan, "TEMP B-TREE")
	}
	plan := mailQueryPlan(t, inbox, mailStateCountsSQL, inbox.sourceID)
	require.Contains(t, plan, "USING COVERING INDEX mail_inbox_state (source_id=?)")
	require.NotContains(t, plan, "TEMP B-TREE")

	// Terminal rows stay out of the partial index but still count per state.
	insertMailInboxRow(t, inbox, testMailEventIDN(151), "complete", "", 0, now.Add(-48*time.Hour).Unix())
	insertMailInboxRow(t, inbox, testMailEventIDN(152), "todo_unknown", "", 0, now.Unix())
	var indexed int
	require.NoError(t, inbox.db.QueryRow(`SELECT count(*) FROM mail_inbox_events INDEXED BY mail_inbox_active
		WHERE source_id=? AND `+mailActiveSQL, inbox.sourceID).Scan(&indexed))
	require.Equal(t, 1, indexed)
	count, err := inbox.attentionCount(context.Background(), now)
	require.NoError(t, err)
	require.Equal(t, 1, count)
}

func TestMailInboxDismissRequiresConfirmationAndResolvableState(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	now := time.Now().Unix()
	insertMailInboxRow(t, inbox, testMailEventIDN(201), "failed_summary", "mail_needs_review", 0, now)
	insertMailInboxRow(t, inbox, testMailEventIDN(202), "todo_unknown", "todo_result_unknown", 0, now)
	insertMailInboxRow(t, inbox, testMailEventIDN(203), "pending", "", 0, now)
	router := gin.New()
	router.POST("/api/v1/mail_inbox/:event_id/reconcile", inbox.handleReconcile)
	call := func(eventID, header, extra string) int {
		body := `{"event_id":"` + eventID + `","resolution":"dismiss"` + extra + `}`
		req := httptest.NewRequest(
			http.MethodPost, "/api/v1/mail_inbox/"+eventID+"/reconcile", strings.NewReader(body),
		)
		if header != "" {
			req.Header.Set("X-Todofy-Admin-Action", header)
		}
		resp := httptest.NewRecorder()
		router.ServeHTTP(resp, req)
		return resp.Code
	}
	const confirmed = `,"confirmed_dismiss":true`
	const header = "reconcile-mail-inbox"
	require.Equal(t, http.StatusBadRequest, call(testMailEventIDN(201), header, ""))
	require.Equal(t, http.StatusBadRequest, call(testMailEventIDN(201), header, `,"confirmed_dismiss":false`))
	require.Equal(t, http.StatusBadRequest, call(testMailEventIDN(201), header, `,"confirm":true`))
	require.Equal(t, http.StatusForbidden, call(testMailEventIDN(201), "", confirmed))
	require.Equal(t, http.StatusNoContent, call(testMailEventIDN(201), header, confirmed))
	require.Equal(t, http.StatusConflict, call(testMailEventIDN(201), header, confirmed))
	require.Equal(t, http.StatusNoContent, call(testMailEventIDN(202), header, confirmed))
	require.Equal(t, http.StatusConflict, call(testMailEventIDN(203), header, confirmed))

	for _, eventID := range []string{testMailEventIDN(201), testMailEventIDN(202)} {
		var state, summary, todoBody, code string
		var payload []byte
		var next int64
		require.NoError(t, inbox.db.QueryRow(`SELECT state,payload,summary,todo_body,last_error_code,next_attempt_at
			FROM mail_inbox_events WHERE event_id=?`, eventID).Scan(&state, &payload, &summary, &todoBody, &code, &next))
		require.Equal(t, "ignored", state)
		require.Nil(t, payload)
		require.Empty(t, summary)
		require.Empty(t, todoBody)
		require.Equal(t, "dismissed_by_owner", code)
		require.Zero(t, next)
	}
	var state string
	require.NoError(t, inbox.db.QueryRow(`SELECT state FROM mail_inbox_events WHERE event_id=?`,
		testMailEventIDN(203)).Scan(&state))
	require.Equal(t, mailStatePending, state)
}

func TestMailInboxTransientSummaryFailuresRetryForSevenDays(t *testing.T) {
	day := int64((24 * time.Hour).Seconds())
	cases := []struct {
		name     string
		invalid  bool
		noLLM    bool
		attempts int
		ageDays  int64
		givesUp  bool
	}{
		{"summary failure within window", false, false, 12, 6, false},
		{"summary failure after window", false, false, 12, 8, true},
		{"summary failure below attempt floor", false, false, 11, 8, false},
		{"llm unavailable within window", false, true, 30, 1, false},
		{"llm unavailable after window", false, true, 12, 8, true},
		{"invalid event keeps attempt rule", true, false, 12, 0, true},
		{"invalid event below attempt rule", true, false, 11, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, inbox := mailInboxFixture(t)
			defer func() { _ = inbox.Close() }()
			now := time.Now().Unix()
			insertMailInboxRow(t, inbox, testMailEventID, mailStatePending, "", tc.attempts, now-tc.ageDays*day)
			wantCode := "summary_failed"
			if tc.invalid {
				wantCode = "invalid_saved_event"
				_, err := inbox.db.Exec(`UPDATE mail_inbox_events SET payload=?`, []byte("{"))
				require.NoError(t, err)
			}
			clients := mocks.NewMockGRPCClients()
			llm := new(mocks.MockLLMSummaryServiceClient)
			if tc.noLLM {
				wantCode = "llm_client_unavailable"
			} else {
				clients.SetClient("llm", llm)
				llm.On("Summarize", mock.Anything, mock.Anything, mock.Anything).
					Return(nil, errors.New("synthetic model outage")).Maybe()
			}
			processed, err := inbox.processOne(context.Background(), clients)
			require.NoError(t, err)
			require.True(t, processed)
			var state, code string
			var attempts int
			var next int64
			require.NoError(t, inbox.db.QueryRow(`SELECT state,last_error_code,attempt_count,next_attempt_at
				FROM mail_inbox_events`).Scan(&state, &code, &attempts, &next))
			require.Equal(t, wantCode, code)
			require.Equal(t, tc.attempts+1, attempts)
			if tc.givesUp {
				require.Equal(t, "failed_summary", state)
				require.Zero(t, next)
			} else {
				require.Equal(t, mailStatePending, state)
				require.GreaterOrEqual(t, next, now+int64(mailRetryDelay(tc.attempts).Seconds()))
			}
		})
	}
}

const (
	testReminderTaskID  = "synthetic-reminder"
	testReminderUnknown = "reminder_result_unknown"
)

type reminderFixture struct {
	cfg   Config
	inbox *mailInbox
	clock time.Time
	todo  *mocks.MockTodoServiceClient
	mocks *mocks.MockGRPCClients
	sent  []*pb.TodoRequest
}

func newReminderFixture(t *testing.T, start time.Time) *reminderFixture {
	t.Helper()
	cfg, inbox := mailInboxFixture(t)
	f := &reminderFixture{cfg: cfg, inbox: inbox, clock: start, todo: new(mocks.MockTodoServiceClient)}
	inbox.now = func() time.Time { return f.clock }
	f.mocks = mocks.NewMockGRPCClients()
	f.mocks.SetClient("todo", f.todo)
	t.Cleanup(func() { _ = f.inbox.Close() })
	return f
}

// expect queues one PopulateTodo result and records the request it received.
func (f *reminderFixture) expect(response *pb.TodoResponse, err error) {
	f.todo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Run(func(args mock.Arguments) { f.sent = append(f.sent, args.Get(1).(*pb.TodoRequest)) }).
		Return(response, err).Once()
}

func (f *reminderFixture) seedAttention(t *testing.T) {
	t.Helper()
	stale := f.clock.Add(-7 * time.Hour).Unix()
	insertMailInboxRow(t, f.inbox, testMailEventIDN(301), "failed_summary", "summary_failed", 13, stale)
	insertMailInboxRow(t, f.inbox, testMailEventIDN(302), "todo_unknown", "", 0, f.clock.Unix())
	insertMailInboxRow(t, f.inbox, testMailEventIDN(303), mailStatePending, "", 0, f.clock.Unix())
	insertMailInboxRow(t, f.inbox, testMailEventIDN(304), "complete", "", 0, stale)
}

type reminderRow struct {
	state, taskID, code, subject, body string
	count, attempts                    int
	next                               int64
}

func (f *reminderFixture) reminder(t *testing.T, day string) reminderRow {
	t.Helper()
	var row reminderRow
	require.NoError(t, f.inbox.db.QueryRow(`SELECT state,task_id,last_error_code,subject,body,attention_count,
		attempts,next_attempt_at FROM mail_inbox_reminders WHERE day=?`, day).
		Scan(&row.state, &row.taskID, &row.code, &row.subject, &row.body, &row.count, &row.attempts, &row.next))
	return row
}

func reminderCount(t *testing.T, inbox *mailInbox) int {
	t.Helper()
	var count int
	require.NoError(t, inbox.db.QueryRow(`SELECT count(*) FROM mail_inbox_reminders`).Scan(&count))
	return count
}

func TestMailInboxReminderSkipsWhenNothingNeedsAttention(t *testing.T) {
	f := newReminderFixture(t, time.Date(2026, 9, 27, 0, 10, 0, 0, time.UTC))
	insertMailInboxRow(t, f.inbox, testMailEventIDN(311), "complete", "", 0, f.clock.Add(-48*time.Hour).Unix())
	insertMailInboxRow(t, f.inbox, testMailEventIDN(312), mailStatePending, "summary_failed", 3, f.clock.Unix())
	require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
	f.todo.AssertNotCalled(t, "PopulateTodo", mock.Anything, mock.Anything, mock.Anything)
	require.Zero(t, reminderCount(t, f.inbox))
}

func TestMailInboxReminderCreatesOneContentFreeTaskPerUTCDay(t *testing.T) {
	f := newReminderFixture(t, time.Date(2026, 9, 27, 0, 10, 0, 0, time.UTC))
	f.seedAttention(t)
	f.expect(&pb.TodoResponse{Id: "synthetic-reminder-1"}, nil)
	f.expect(&pb.TodoResponse{Id: "synthetic-reminder-2"}, nil)
	for range 3 {
		require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
	}
	f.clock = f.clock.Add(20 * time.Hour)
	require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
	f.todo.AssertNumberOfCalls(t, "PopulateTodo", 1)
	row := f.reminder(t, "2026-09-27")
	require.Equal(t, "created", row.state)
	require.Equal(t, "synthetic-reminder-1", row.taskID)
	require.Equal(t, 2, row.count)
	require.Zero(t, row.attempts)
	require.Empty(t, row.code)

	require.Len(t, f.sent, 1)
	req := f.sent[0]
	require.Equal(t, utils.SystemAutomaticallyEmailPrefix+" Mail Hero：2 封邮件需要处理", req.Subject)
	require.Equal(t, "todofy", req.From)
	require.Equal(t, pb.TodoApp_TODO_APP_TODOIST, req.App)
	require.Equal(t, row.subject, req.Subject)
	require.Equal(t, row.body, req.Body)
	for _, want := range []string{
		"- " + testMailEventIDN(301) + " · failed_summary · summary_failed · 收到 2026-09-26T17:10:00Z",
		"- " + testMailEventIDN(302) + " · todo_unknown · - · 收到 2026-09-27T00:10:00Z",
		"view=attention", "X-Todofy-Admin-Action: reconcile-mail-inbox",
		"task_created", "task_not_created", "retry_summary", "dismiss",
	} {
		require.Contains(t, req.Body, want)
	}
	for _, leaked := range []string{"Synthetic", "sender@example.org", testMailEventIDN(303), testMailEventIDN(304)} {
		require.NotContains(t, req.Body, leaked)
		require.NotContains(t, req.Subject, leaked)
	}

	f.clock = time.Date(2026, 9, 28, 0, 5, 0, 0, time.UTC)
	require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
	require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
	f.todo.AssertNumberOfCalls(t, "PopulateTodo", 2)
	row = f.reminder(t, "2026-09-28")
	require.Equal(t, "created", row.state)
	require.Equal(t, "synthetic-reminder-2", row.taskID)
	// The 2026-09-27 pending row is now older than six hours.
	require.Equal(t, 3, row.count)
}

// Once today's reminder is settled, the idle check must not read the ledger.
func TestMailInboxSettledReminderDayReadsOnlyItsOwnRow(t *testing.T) {
	f := newReminderFixture(t, time.Date(2026, 9, 27, 0, 10, 0, 0, time.UTC))
	f.seedAttention(t)
	f.expect(&pb.TodoResponse{Id: testReminderTaskID}, nil)
	require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
	_, err := f.inbox.db.Exec(`ALTER TABLE mail_inbox_events RENAME TO mail_inbox_events_hidden`)
	require.NoError(t, err)
	f.clock = f.clock.Add(time.Hour)
	require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
	_, err = f.inbox.db.Exec(`ALTER TABLE mail_inbox_events_hidden RENAME TO mail_inbox_events`)
	require.NoError(t, err)
	f.todo.AssertNumberOfCalls(t, "PopulateTodo", 1)
}

func TestMailInboxReminderBodyIsBoundedToTwentyRows(t *testing.T) {
	f := newReminderFixture(t, time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC))
	for n := range 23 {
		insertMailInboxRow(t, f.inbox, testMailEventIDN(400+n), "failed_summary", "mail_needs_review", 0,
			f.clock.Add(-time.Duration(30-n)*time.Minute).Unix())
	}
	body, err := f.inbox.reminderBody(context.Background(), f.clock, "2026-09-27", 23)
	require.NoError(t, err)
	require.Equal(t, 20, strings.Count(body, " · mail_needs_review · "))
	require.Contains(t, body, testMailEventIDN(400))
	require.Contains(t, body, testMailEventIDN(419))
	require.NotContains(t, body, testMailEventIDN(420))
	require.Contains(t, body, "- … 另有 3 条\n")
}

func TestMailInboxReminderTimerChecksAtMostEveryTenMinutes(t *testing.T) {
	f := newReminderFixture(t, time.Date(2026, 9, 27, 23, 55, 0, 0, time.UTC))
	f.seedAttention(t)
	f.expect(&pb.TodoResponse{Id: "synthetic-reminder-1"}, nil)
	f.expect(&pb.TodoResponse{Id: "synthetic-reminder-2"}, nil)
	f.inbox.remindIfDue(context.Background(), f.mocks)
	f.todo.AssertNumberOfCalls(t, "PopulateTodo", 1)
	f.clock = f.clock.Add(6 * time.Minute) // a new UTC day, but inside the interval
	f.inbox.remindIfDue(context.Background(), f.mocks)
	f.todo.AssertNumberOfCalls(t, "PopulateTodo", 1)
	f.clock = f.clock.Add(5 * time.Minute)
	f.inbox.remindIfDue(context.Background(), f.mocks)
	f.todo.AssertNumberOfCalls(t, "PopulateTodo", 2)
	require.Equal(t, 2, reminderCount(t, f.inbox))
}

// runWorker is the reminder's only production caller.
func TestMailInboxWorkerCreatesReminderWhenIdle(t *testing.T) {
	f := newReminderFixture(t, time.Date(2026, 9, 27, 9, 0, 0, 0, time.UTC))
	insertMailInboxRow(t, f.inbox, testMailEventIDN(351), "failed_summary", "summary_failed", 13, f.clock.Unix())
	f.todo.On("PopulateTodo", mock.Anything, mock.Anything, mock.Anything).
		Return(&pb.TodoResponse{Id: testReminderTaskID}, nil).Once()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.inbox.runWorker(ctx, f.mocks)
	}()
	require.Eventually(t, func() bool {
		var state string
		err := f.inbox.db.QueryRow(`SELECT state FROM mail_inbox_reminders WHERE day='2026-09-27'`).Scan(&state)
		return err == nil && state == "created"
	}, 5*time.Second, 10*time.Millisecond)
	cancel()
	<-done
	f.todo.AssertNumberOfCalls(t, "PopulateTodo", 1)
}

func captureMailLog(t *testing.T) *logtest.Hook {
	t.Helper()
	previous := log.ReplaceHooks(make(logrus.LevelHooks))
	t.Cleanup(func() { log.ReplaceHooks(previous) })
	return logtest.NewLocal(log)
}

// A retry resends the request frozen at the first claim, so the todo
// service's Todoist X-Request-Id cannot change even if the attention set does.
func TestMailInboxReminderRetriesOnlyCertainFailuresWithFrozenRequest(t *testing.T) {
	t.Run("gives up after five failures", func(t *testing.T) {
		f := newReminderFixture(t, time.Date(2026, 9, 27, 0, 10, 0, 0, time.UTC))
		f.seedAttention(t)
		logs := captureMailLog(t)
		for range 5 {
			f.expect(nil, status.Error(codes.Unavailable, "synthetic todo service down"))
		}
		for attempt := 1; attempt <= 5; attempt++ {
			require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
			row := f.reminder(t, "2026-09-27")
			require.Equal(t, "failed", row.state)
			require.Equal(t, "reminder_create_failed", row.code)
			require.Equal(t, attempt, row.attempts)
			require.Equal(t, f.clock.Add(time.Hour).Unix(), row.next)
			// New stuck mail must not change the retried request.
			insertMailInboxRow(t, f.inbox, testMailEventIDN(320+attempt), "todo_unknown", "", 0, f.clock.Unix())
			f.clock = f.clock.Add(59 * time.Minute)
			require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
			f.todo.AssertNumberOfCalls(t, "PopulateTodo", attempt)
			f.clock = f.clock.Add(time.Minute)
		}
		f.clock = f.clock.Add(2 * time.Hour)
		require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
		f.todo.AssertNumberOfCalls(t, "PopulateTodo", 5)
		require.Len(t, f.sent, 5)
		for _, req := range f.sent[1:] {
			require.Equal(t, f.sent[0].Subject, req.Subject)
			require.Equal(t, f.sent[0].Body, req.Body)
			require.Equal(t, f.sent[0].From, req.From)
		}
		require.Contains(t, f.sent[0].Subject, "2 封邮件需要处理")
		require.Len(t, logs.AllEntries(), 5)
		entry := logs.LastEntry()
		require.Equal(t, logrus.WarnLevel, entry.Level)
		require.Equal(t, "reminder_create_failed", entry.Data["error_code"])
		require.Equal(t, 5, entry.Data["attempt"])
		require.NotContains(t, fmt.Sprint(entry.Data), "synthetic todo service down")

		_, _, resp := mailStatusRequest(t, f.inbox, "")
		require.NotNil(t, resp.LatestReminder)
		require.Equal(t, "2026-09-27", resp.LatestReminder.Day)
		require.Equal(t, "failed", resp.LatestReminder.State)
		require.Equal(t, 5, resp.LatestReminder.Attempts)
		require.Equal(t, "reminder_create_failed", resp.LatestReminder.ErrorCode)
	})
	t.Run("recovers on a later attempt", func(t *testing.T) {
		f := newReminderFixture(t, time.Date(2026, 9, 27, 0, 10, 0, 0, time.UTC))
		f.seedAttention(t)
		f.expect(nil, status.Error(codes.Unavailable, "synthetic todo service down"))
		f.expect(&pb.TodoResponse{Id: testReminderTaskID}, nil)
		for range 3 {
			require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
			f.clock = f.clock.Add(time.Hour)
		}
		row := f.reminder(t, "2026-09-27")
		require.Equal(t, "created", row.state)
		require.Equal(t, testReminderTaskID, row.taskID)
		require.Equal(t, 1, row.attempts)
		require.Empty(t, row.code)
		f.todo.AssertNumberOfCalls(t, "PopulateTodo", 2)
		require.Equal(t, f.sent[0].Body, f.sent[1].Body)
	})
	t.Run("missing todo client is retried", func(t *testing.T) {
		f := newReminderFixture(t, time.Date(2026, 9, 27, 0, 10, 0, 0, time.UTC))
		f.seedAttention(t)
		require.NoError(t, f.inbox.maybeRemind(context.Background(), mocks.NewMockGRPCClients()))
		row := f.reminder(t, "2026-09-27")
		require.Equal(t, "failed", row.state)
		require.Equal(t, "todo_client_unavailable", row.code)
		f.expect(&pb.TodoResponse{Id: testReminderTaskID}, nil)
		f.clock = f.clock.Add(time.Hour)
		require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
		require.Equal(t, "created", f.reminder(t, "2026-09-27").state)
		require.Equal(t, row.body, f.sent[0].Body)
	})
}

// Like createTodo's todo_unknown, a result that may hide a created task is
// never resent that UTC day: a missed reminder beats a duplicate.
func TestMailInboxReminderAmbiguousResultIsNeverResentThatDay(t *testing.T) {
	cases := []struct {
		name     string
		response *pb.TodoResponse
		err      error
		code     string
	}{
		{"deadline", nil, status.Error(codes.DeadlineExceeded, "synthetic deadline"), testReminderUnknown},
		{"canceled", nil, status.Error(codes.Canceled, "synthetic cancel"), testReminderUnknown},
		{"todoist error", nil, errors.New("synthetic Todoist error"), testReminderUnknown},
		{"internal", nil, status.Error(codes.Internal, "synthetic internal"), testReminderUnknown},
		{"empty task id", &pb.TodoResponse{Message: "created"}, nil, "empty_task_id"},
		{"no response", nil, nil, "empty_task_id"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newReminderFixture(t, time.Date(2026, 9, 27, 1, 0, 0, 0, time.UTC))
			insertMailInboxRow(t, f.inbox, testMailEventIDN(361), "todo_unknown", "todo_result_unknown", 0,
				f.clock.Add(-time.Hour).Unix())
			// Crosses the 6-hour rule before the next check, changing the count.
			insertMailInboxRow(t, f.inbox, testMailEventIDN(362), mailStatePending, "summary_failed", 3,
				f.clock.Add(-5*time.Hour-30*time.Minute).Unix())
			f.expect(tc.response, tc.err)
			f.expect(&pb.TodoResponse{Id: "synthetic-next-day"}, nil)
			require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
			row := f.reminder(t, "2026-09-27")
			require.Equal(t, "unknown", row.state)
			require.Equal(t, tc.code, row.code)
			require.Equal(t, 1, row.attempts)
			for range 22 {
				f.clock = f.clock.Add(time.Hour)
				require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
			}
			f.todo.AssertNumberOfCalls(t, "PopulateTodo", 1)
			f.clock = time.Date(2026, 9, 28, 0, 5, 0, 0, time.UTC)
			require.NoError(t, f.inbox.maybeRemind(context.Background(), f.mocks))
			f.todo.AssertNumberOfCalls(t, "PopulateTodo", 2)
			require.Equal(t, "created", f.reminder(t, "2026-09-28").state)
		})
	}
}

func TestMailInboxReminderInterruptedSendIsUnknownOnRestart(t *testing.T) {
	f := newReminderFixture(t, time.Date(2026, 9, 27, 8, 0, 0, 0, time.UTC))
	f.seedAttention(t)
	_, err := f.inbox.db.Exec(`INSERT INTO mail_inbox_reminders(day,state,attention_count,created_at,updated_at)
		VALUES('2026-09-27','sending',2,?,?)`, f.clock.Unix(), f.clock.Unix())
	require.NoError(t, err)
	require.NoError(t, f.inbox.Close())
	reopened, err := openMailInbox(f.cfg)
	require.NoError(t, err)
	f.inbox = reopened
	reopened.now = func() time.Time { return f.clock }
	row := f.reminder(t, "2026-09-27")
	require.Equal(t, "unknown", row.state)
	require.Equal(t, "interrupted_reminder_call", row.code)
	f.clock = f.clock.Add(12 * time.Hour)
	require.NoError(t, reopened.maybeRemind(context.Background(), f.mocks))
	f.todo.AssertNotCalled(t, "PopulateTodo", mock.Anything, mock.Anything, mock.Anything)
}

func TestMailInboxReminderCanBeDisabled(t *testing.T) {
	cfg, inbox := mailInboxFixture(t)
	require.NoError(t, inbox.Close())
	cfg.MailAttentionReminder = "false"
	disabled, err := openMailInbox(cfg)
	require.NoError(t, err)
	defer func() { _ = disabled.Close() }()
	insertMailInboxRow(t, disabled, testMailEventIDN(501), "todo_unknown", "", 0, time.Now().Unix())
	clients := mocks.NewMockGRPCClients()
	todo := new(mocks.MockTodoServiceClient)
	clients.SetClient("todo", todo)
	require.NoError(t, disabled.maybeRemind(context.Background(), clients))
	disabled.remindIfDue(context.Background(), clients)
	todo.AssertNotCalled(t, "PopulateTodo", mock.Anything, mock.Anything, mock.Anything)
	require.Zero(t, reminderCount(t, disabled))

	for _, tc := range []struct {
		value string
		want  bool
	}{{"", true}, {"true", true}, {"  TRUE\t", true}, {"false", false}, {"0", false}} {
		enabled, err := mailReminderEnabled(tc.value)
		require.NoError(t, err, tc.value)
		require.Equal(t, tc.want, enabled, tc.value)
	}
	cfg.MailAttentionReminder = "sometimes"
	require.ErrorContains(t, validateMailInboxConfig(cfg), "TODOFY_MAIL_ATTENTION_REMINDER")
	// The reminder switch alone never enables a partially configured inbox.
	require.NoError(t, validateMailInboxConfig(Config{MailAttentionReminder: "sometimes"}))
}

func TestMailInboxReminderFlagReadsEnvironment(t *testing.T) {
	t.Setenv("TODOFY_MAIL_ATTENTION_REMINDER", "false")
	cfg := Config{}
	fs := flag.NewFlagSet("todofy-mail-reminder", flag.ContinueOnError)
	initFlagsWithFlagSet(fs, &cfg)
	require.NoError(t, fs.Parse(nil))
	require.Equal(t, "false", cfg.MailAttentionReminder)
	require.NoError(t, fs.Parse([]string{"-mail-attention-reminder=true"}))
	require.Equal(t, "true", cfg.MailAttentionReminder)
}

func TestMailInboxReminderTableRejectsUnknownState(t *testing.T) {
	_, inbox := mailInboxFixture(t)
	defer func() { _ = inbox.Close() }()
	_, err := inbox.db.Exec(`INSERT INTO mail_inbox_reminders(day,state,attention_count,created_at,updated_at)
		VALUES('2026-09-27','retrying',1,0,0)`)
	require.Error(t, err)
	var state string
	err = inbox.db.QueryRow(`SELECT state FROM mail_inbox_reminders`).Scan(&state)
	require.ErrorIs(t, err, sql.ErrNoRows)
}
