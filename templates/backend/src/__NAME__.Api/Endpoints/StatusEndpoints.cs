using __NAME__.Application.Status;

namespace __NAME__.Api.Endpoints;

public static class StatusEndpoints
{
    public static void MapStatusEndpoints(this IEndpointRouteBuilder api) =>
        api.MapGet("/status", (GetStatus getStatus) => TypedResults.Ok(getStatus.Handle()));
}
