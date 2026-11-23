namespace __NAME__.Application.Status;

/// <summary>Which service is running, and which build of it.</summary>
public sealed record ServiceInfo(string Name, string Version);

/// <summary>What the service reports about itself.</summary>
public sealed record StatusResponse(string Service, string Version, DateTimeOffset CheckedAt);

/// <summary>Use case: report that the service is up and which build is answering.</summary>
public sealed class GetStatus(ServiceInfo service, TimeProvider clock)
{
    public StatusResponse Handle() => new(service.Name, service.Version, clock.GetUtcNow());
}
