using __NAME__.Application.Status;

namespace __NAME__.Application.Tests.Status;

public sealed class GetStatusTests
{
    [Fact]
    public void Given_a_running_service_When_status_is_requested_Then_it_reports_the_service_its_version_and_the_time()
    {
        var now = new DateTimeOffset(2026, 1, 2, 3, 4, 5, TimeSpan.Zero);
        var getStatus = new GetStatus(new ServiceInfo("demo", "1.2.3"), new FixedClock(now));

        var status = getStatus.Handle();

        Assert.Equal(new StatusResponse("demo", "1.2.3", now), status);
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
