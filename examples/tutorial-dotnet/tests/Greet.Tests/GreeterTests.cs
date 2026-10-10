using Greet;
using Xunit;

namespace Greet.Tests;

public class GreeterTests
{
    [Fact]
    public void GreetsByName()
    {
        Assert.Equal("Hello, hammerkit!", Greeter.Hello("hammerkit"));
    }
}
