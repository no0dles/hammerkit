using Hello;
using Xunit;

namespace Hello.Tests;

public class GreeterTests
{
    [Fact]
    public void GreetsByName()
    {
        Assert.Equal("hello dotnet", Greeter.Greet("dotnet"));
    }
}
