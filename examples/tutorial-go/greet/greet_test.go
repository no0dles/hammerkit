package greet

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestHello(t *testing.T) {
	if diff := cmp.Diff("Hello, hammerkit!", Hello("hammerkit")); diff != "" {
		t.Errorf("Hello() mismatch (-want +got):\n%s", diff)
	}
}
