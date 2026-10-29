package app

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/provider/workflow"
)

func TestNativeWorkflowPollSkipsCloudWarmup(t *testing.T) {
	poller := workflowVideoPoller{}
	cloud := poller.appPolicy(workflow.PollPolicy{})
	if cloud.InitialDelay != defaultVideoPollPolicy().InitialDelay {
		t.Fatal("existing cloud warmup changed")
	}
	native := poller.appPolicy(workflow.PollPolicy{SkipInitialDelay: true, Interval: 2 * time.Second})
	if native.InitialDelay != 0 || native.Interval != 2*time.Second {
		t.Fatalf("native policy = %+v", native)
	}
}
