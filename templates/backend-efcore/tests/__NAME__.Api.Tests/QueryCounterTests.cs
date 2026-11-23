using __NAME__.Api.Tests.Support;
using __NAME__.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace __NAME__.Api.Tests;

public sealed class QueryCounterTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    [Fact]
    public async Task Given_two_commands_reach_the_database_When_they_are_counted_Then_the_count_is_two()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var queries = await factory.Queries.CountAsync(async () =>
        {
            await db.Database.ExecuteSqlRawAsync("SELECT 1");
            await db.Database.ExecuteSqlRawAsync("SELECT 1");
        });

        Assert.Equal(2, queries);
    }
}
