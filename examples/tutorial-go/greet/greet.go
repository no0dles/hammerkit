package greet

import "fmt"

// Hello returns the greeting for name.
func Hello(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}
