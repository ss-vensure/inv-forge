using System.Net.Http.Json;
using __NAME__.Api.Tests.Support;
using __NAME__.Application.Status;

namespace __NAME__.Api.Tests;

public sealed class StatusEndpointTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    [Fact]
    public async Task Given_the_api_is_running_When_status_is_requested_under_the_route_slug_Then_it_names_the_service()
    {
        using var client = factory.CreateClient();

        var status = await client.GetFromJsonAsync<StatusResponse>("/__SLUG__/api/status");

        Assert.Equal("__SLUG__", status?.Service);
    }

    [Fact]
    public async Task Given_the_api_is_running_When_status_is_requested_Then_it_does_not_touch_the_database()
    {
        using var client = factory.CreateClient();

        var queries = await factory.Queries.CountAsync(() => client.GetAsync("/__SLUG__/api/status"));

        Assert.Equal(0, queries);
    }
}
