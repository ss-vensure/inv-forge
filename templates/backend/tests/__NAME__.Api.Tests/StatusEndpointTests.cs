using System.Net.Http.Json;
using __NAME__.Application.Status;
using Microsoft.AspNetCore.Mvc.Testing;

namespace __NAME__.Api.Tests;

public sealed class StatusEndpointTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Given_the_api_is_running_When_status_is_requested_under_the_route_slug_Then_it_names_the_service()
    {
        using var client = factory.CreateClient();

        var status = await client.GetFromJsonAsync<StatusResponse>("/__SLUG__/api/status");

        Assert.Equal("__SLUG__", status?.Service);
    }
}
