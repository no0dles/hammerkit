package main

import "fmt"

func Greeting(name string) string {
	return "hello " + name
}

func main() {
	fmt.Println(Greeting("catalog"))
}
